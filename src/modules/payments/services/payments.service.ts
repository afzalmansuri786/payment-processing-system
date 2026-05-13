import { InjectQueue } from '@nestjs/bullmq';
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';

import { loadPaymentConfig } from 'src/config/payment.config';

import { InternalWebhookEmitterService } from '../../webhooks/internal-webhook-emitter.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { Payment } from '../entities/payment.entity';
import { PaymentStatus } from '../enums/payment-status.enum';

// postgres unique_violation code
const POSTGRES_UNIQUE_VIOLATION_CODE = '23505';

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);
    private readonly paymentConfig = loadPaymentConfig();

    constructor(
        @InjectRepository(Payment)
        private readonly paymentRepository: Repository<Payment>,

        @InjectQueue('payment-queue')
        private readonly paymentQueue: Queue,

        private readonly internalWebhookEmitter: InternalWebhookEmitterService,
    ) {}

    /**
     * Creates a payment (status INITIATED), queues it for the worker,
     * and emits an INITIATED self-webhook so the audit trail in
     * webhook_events is complete from the very first state.
     *
     * Idempotency-Key is required. Same key = same payment, even if
     * sent at the exact same millisecond (the unique constraint on
     * the column protects us if two requests slip past the findOne).
     */
    async createPayment(
        dto: CreatePaymentDto,
        idempotencyKey: string,
    ) {
        if (!idempotencyKey || idempotencyKey.trim().length === 0) {
            throw new BadRequestException(
                'Missing required header: Idempotency-Key',
            );
        }

        // Fast path: key already exists, return the existing payment.
        const existingPayment = await this.paymentRepository.findOne({
            where: { idempotencyKey },
        });

        if (existingPayment) {
            this.logger.log(
                `Idempotent replay for key=${idempotencyKey} -> payment ${existingPayment.id} (${existingPayment.status})`,
            );
            return this.toResponse(
                existingPayment,
                'Existing payment returned (idempotent replay)',
            );
        }

        // Try to insert. If two requests with the same key arrive
        // at the same moment they'll both miss the findOne above,
        // both try to save, and one will hit the unique constraint
        // — we catch that and refetch the winner.
        let savedPayment: Payment;
        try {
            const draftPayment = this.paymentRepository.create({
                ...dto,
                idempotencyKey,
                status: PaymentStatus.INITIATED,
            });
            savedPayment = await this.paymentRepository.save(
                draftPayment,
            );
        } catch (err) {
            if (
                err instanceof QueryFailedError &&
                (err as any).code === POSTGRES_UNIQUE_VIOLATION_CODE
            ) {
                const winningPayment =
                    await this.paymentRepository.findOneOrFail({
                        where: { idempotencyKey },
                    });
                this.logger.warn(
                    `Idempotency race resolved for key=${idempotencyKey}: winner is ${winningPayment.id}`,
                );
                return this.toResponse(
                    winningPayment,
                    'Concurrent idempotent request — returning existing payment',
                );
            }
            throw err;
        }

        this.logger.log(
            `Payment ${savedPayment.id} created (amount=${savedPayment.amount} ${savedPayment.currency})`,
        );

        // Emit an INITIATED self-webhook so the very first state of
        // the payment lands in webhook_events too. Fire-and-forget;
        // the webhook handler will see status=INITIATED, current
        // status=INITIATED, and record a no-op event.
        await this.internalWebhookEmitter.emitWebhookForPayment({
            paymentId: savedPayment.id,
            status: PaymentStatus.INITIATED,
        });

        // Queue for the worker. The jobId is tied to the paymentId
        // so the same payment can never be enqueued twice.
        await this.paymentQueue.add(
            'process-payment',
            { paymentId: savedPayment.id },
            {
                jobId: `process-${savedPayment.id}`,
                attempts: this.paymentConfig.maxAttempts,
                backoff: {
                    type: 'exponential',
                    delay: this.paymentConfig.backoffInitialMs,
                },
                removeOnComplete: { age: 3600 },
                removeOnFail: false,
            },
        );

        return this.toResponse(savedPayment, 'Payment initiated');
    }

    /**
     * Read a payment by id. Returns the same sanitized shape as
     * createPayment so the API is consistent.
     */
    async getPayment(id: string) {
        const payment = await this.paymentRepository.findOne({
            where: { id },
        });

        if (!payment) {
            throw new NotFoundException(`Payment ${id} not found`);
        }

        return this.toResponse(payment, 'Payment fetched');
    }

    /**
     * Sanitized response shape. Keeps internal fields like the
     * version column and the idempotencyKey out of the API surface.
     */
    private toResponse(payment: Payment, message: string) {
        return {
            message,
            payment: {
                id: payment.id,
                amount: payment.amount,
                currency: payment.currency,
                status: payment.status,
                attemptCount: payment.attemptCount,
                gatewayTransactionId: payment.gatewayTransactionId,
                failureReason: payment.failureReason,
                processedAt: payment.processedAt,
                createdAt: payment.createdAt,
                updatedAt: payment.updatedAt,
            },
        };
    }
}
