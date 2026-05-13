import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';

import {
    NonRetriableGatewayError,
    TransientGatewayError,
} from 'src/common/exceptions/gateway-errors';
import { RedisService } from 'src/common/redis/redis.service';
import { loadPaymentConfig } from 'src/config/payment.config';

import { InternalWebhookEmitterService } from '../../webhooks/internal-webhook-emitter.service';
import { Payment } from '../entities/payment.entity';
import { PaymentStatus, isTerminal } from '../enums/payment-status.enum';
import { FakeGatewayService } from '../services/fake-gateway.service';

interface ProcessPaymentJobData {
    paymentId: string;
}

/**
 * Background worker that actually moves money (well, pretends to).
 *
 * The flow now is:
 *   1. Grab a Redis lock so two workers don't fight over the same payment
 *   2. Emit a PROCESSING self-webhook (this is what flips the DB status)
 *   3. Call the fake gateway
 *   4. Emit a SUCCESS / FAILED / BLOCKED self-webhook with the result
 *
 * Notice the processor never writes to the payment table itself
 * anymore — it just emits webhooks. The webhook handler does the
 * DB writes under a row lock. This way internal events and real
 * external gateway events hit the exact same code path, and
 * everything ends up in webhook_events for the audit trail.
 */
@Injectable()
@Processor('payment-queue')
export class PaymentProcessor extends WorkerHost {
    private readonly logger = new Logger(PaymentProcessor.name);
    private readonly paymentConfig = loadPaymentConfig();

    constructor(
        @InjectRepository(Payment)
        private readonly paymentRepository: Repository<Payment>,

        private readonly fakeGatewayService: FakeGatewayService,
        private readonly redisService: RedisService,
        private readonly internalWebhookEmitter: InternalWebhookEmitterService,
    ) {
        super();
    }

    async process(job: Job<ProcessPaymentJobData>): Promise<void> {
        const { paymentId } = job.data;
        const redisLockKey = `lock:payment:${paymentId}`;

        // First defence: Redis lock. Stops two workers running on
        // the same payment if BullMQ ever redelivers a job after a
        // worker crash.
        const lockToken = await this.redisService.acquireLock(
            redisLockKey,
            this.paymentConfig.lockTtlSeconds,
        );

        if (!lockToken) {
            this.logger.warn(
                `Payment ${paymentId} is already being processed elsewhere — backing off (attempt ${job.attemptsMade + 1})`,
            );
            // Throw so BullMQ retries with backoff; by then the
            // other worker should be done.
            throw new TransientGatewayError(
                'Concurrent processing in progress',
            );
        }

        try {
            await this.runPaymentJob(paymentId, job);
        } finally {
            await this.redisService.releaseLock(
                redisLockKey,
                lockToken,
            );
        }
    }

    private async runPaymentJob(
        paymentId: string,
        job: Job<ProcessPaymentJobData>,
    ): Promise<void> {
        // Quick sanity check before doing anything expensive.
        const currentPayment = await this.paymentRepository.findOne({
            where: { id: paymentId },
        });

        if (!currentPayment) {
            this.logger.error(
                `Payment ${paymentId} not found in DB — can't process`,
            );
            // Unrecoverable means BullMQ won't retry. Right call here
            // because there's no payment to process.
            throw new UnrecoverableError(
                `Payment ${paymentId} not found`,
            );
        }

        if (isTerminal(currentPayment.status)) {
            // Someone (a webhook) beat us to it. Nothing to do.
            this.logger.warn(
                `Payment ${paymentId} already terminal (${currentPayment.status}) before we started — skipping`,
            );
            return;
        }

        // Step 1 — flip payment to PROCESSING by emitting a webhook
        // to ourselves. The webhook handler will:
        //   - lock the payment row
        //   - move INITIATED -> PROCESSING (or no-op if already PROCESSING)
        //   - bump attemptCount
        //   - record in webhook_events
        await this.internalWebhookEmitter.emitWebhookForPayment({
            paymentId,
            status: PaymentStatus.PROCESSING,
        });

        // Step 2 — call the fake gateway. This is where the actual
        // "talking to the bank" simulation happens.
        try {
            const gatewayResponse =
                await this.fakeGatewayService.processPayment(
                    paymentId,
                );

            // Step 3 — gateway said SUCCESS. Emit a final webhook.
            await this.internalWebhookEmitter.emitWebhookForPayment({
                paymentId,
                status: gatewayResponse.status,
                gatewayTransactionId:
                    gatewayResponse.transactionId,
            });

            this.logger.log(
                `Payment ${paymentId} -> SUCCESS (txn=${gatewayResponse.transactionId}, attempt ${job.attemptsMade + 1})`,
            );
        } catch (err) {
            await this.handleGatewayError(err, paymentId, job);
        }
    }

    /**
     * Different errors get treated differently:
     *  - NonRetriable (declined / fraud block) → emit final terminal
     *    webhook, DON'T rethrow (no point retrying)
     *  - Transient on the last attempt → emit FAILED webhook so the
     *    payment doesn't get stuck in PROCESSING forever
     *  - Transient with retries left → rethrow so BullMQ retries
     */
    private async handleGatewayError(
        err: unknown,
        paymentId: string,
        job: Job<ProcessPaymentJobData>,
    ): Promise<void> {
        if (err instanceof NonRetriableGatewayError) {
            const finalStatus =
                err.finalStatus === 'BLOCKED'
                    ? PaymentStatus.BLOCKED
                    : PaymentStatus.FAILED;

            await this.internalWebhookEmitter.emitWebhookForPayment({
                paymentId,
                status: finalStatus,
                reason: err.message,
            });

            this.logger.warn(
                `Payment ${paymentId} -> ${err.finalStatus} (non-retriable: ${err.message})`,
            );

            return;
        }

        const errorMessage =
            (err as Error)?.message ?? 'unknown error';
        const isLastAttempt =
            job.attemptsMade + 1 >= this.paymentConfig.maxAttempts;

        if (isLastAttempt) {
            // Out of retries — finalize as FAILED with the last
            // error so the payment row doesn't get stuck in
            // PROCESSING forever.
            await this.internalWebhookEmitter.emitWebhookForPayment({
                paymentId,
                status: PaymentStatus.FAILED,
                reason: `Exhausted retries: ${errorMessage}`,
            });
            this.logger.error(
                `Payment ${paymentId} -> FAILED after ${this.paymentConfig.maxAttempts} attempts: ${errorMessage}`,
            );
            return;
        }

        // Still have retries left. Rethrow so BullMQ schedules
        // another attempt with exponential backoff.
        this.logger.warn(
            `Payment ${paymentId} transient failure on attempt ${job.attemptsMade + 1}: ${errorMessage} — will retry`,
        );
        throw err;
    }
}
