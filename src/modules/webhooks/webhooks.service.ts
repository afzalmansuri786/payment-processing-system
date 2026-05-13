import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { DataSource, QueryFailedError } from 'typeorm';

import { loadPaymentConfig } from 'src/config/payment.config';

import { WebhookDto } from '../payments/dto/webhook.dto';
import { Payment } from '../payments/entities/payment.entity';
import {
    WebhookEvent,
    WebhookEventStatus,
} from '../payments/entities/webhook-event.entity';
import {
    PaymentStatus,
    isTerminal,
} from '../payments/enums/payment-status.enum';
import { canTransitionPaymentStatus } from '../payments/utils/payment-state.util';

const POSTGRES_UNIQUE_VIOLATION_CODE = '23505';

/**
 * Handles every incoming webhook — whether it came from a real
 * gateway out on the internet or from our own processor doing a
 * self-call. The shape is the same, so the code is the same.
 *
 * Big picture:
 *  1. Check the signature. Bad sig = 401, recorded for audit.
 *  2. Insert into webhook_events. The DB's unique index on eventId
 *     is what stops duplicates — much safer than checking first.
 *  3. Open a transaction, lock the payment row, apply the state
 *     change if it's a valid transition. Locking means the worker
 *     and any other webhook can't race us.
 */
@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name);
    private readonly paymentConfig = loadPaymentConfig();

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
    ) {}

    /**
     * Compare the X-Webhook-Signature header against what we'd
     * compute from the raw body. Constant-time compare so an attacker
     * can't probe the signature byte by byte using response timing.
     */
    verifySignature(
        rawBody: Buffer | string,
        signature: string | undefined,
    ): void {
        if (!this.paymentConfig.webhookSigningSecret) {
            // Misconfigured server. Better to 400 than to silently
            // accept anything.
            throw new BadRequestException(
                'Server missing WEBHOOK_SIGNING_SECRET — refusing to process webhooks',
            );
        }

        if (!signature) {
            throw new UnauthorizedException(
                'Missing X-Webhook-Signature header',
            );
        }

        const expectedSignatureHex = createHmac(
            'sha256',
            this.paymentConfig.webhookSigningSecret,
        )
            .update(rawBody)
            .digest('hex');

        // timingSafeEqual needs equal-length buffers, otherwise it
        // throws — so check length first.
        const providedSignatureBuffer = Buffer.from(signature, 'hex');
        const expectedSignatureBuffer = Buffer.from(
            expectedSignatureHex,
            'hex',
        );

        if (
            providedSignatureBuffer.length !==
            expectedSignatureBuffer.length
        ) {
            throw new UnauthorizedException('Invalid signature');
        }

        if (
            !timingSafeEqual(
                providedSignatureBuffer,
                expectedSignatureBuffer,
            )
        ) {
            throw new UnauthorizedException('Invalid signature');
        }
    }

    /**
     * The main handler. Records the event, then applies the state
     * change under a row lock.
     */
    async handleIncomingWebhook(
        dto: WebhookDto,
        rawBody: Buffer | string,
    ) {
        // --- 1. Dedup at the DB level ---
        // We INSERT the event first. If another request with the same
        // eventId is already in flight, the unique index on eventId
        // will reject our insert. This is the atomic dedup — much
        // safer than "check then insert" which can race.
        try {
            await this.dataSource.getRepository(WebhookEvent).insert({
                eventId: dto.eventId,
                paymentId: dto.paymentId,
                status: dto.status,
                payload: this.tryParseJson(rawBody),
                processingStatus: WebhookEventStatus.RECEIVED,
            });
        } catch (err) {
            if (this.isUniqueViolation(err)) {
                this.logger.warn(
                    `Duplicate webhook ignored: eventId=${dto.eventId}`,
                );
                return {
                    message: 'Duplicate webhook ignored',
                    duplicate: true,
                };
            }
            throw err;
        }

        // --- 2. Apply the state change ---
        // Whole thing in a transaction, with a row lock on the
        // payment. If the processor (or another webhook) is updating
        // this same payment right now, it waits until we commit.
        return this.dataSource.transaction(async (entityManager) => {
            const payment = await entityManager.findOne(Payment, {
                where: { id: dto.paymentId },
                lock: { mode: 'pessimistic_write' },
            });

            if (!payment) {
                // Sometimes gateways send events for payments we
                // don't recognise (test events, sibling services).
                // Don't 404 — just record it and move on.
                await entityManager.update(
                    WebhookEvent,
                    { eventId: dto.eventId },
                    {
                        processingStatus: WebhookEventStatus.REJECTED,
                        note: 'Unknown payment',
                    },
                );
                this.logger.error(
                    `Webhook ${dto.eventId} is for payment ${dto.paymentId} which doesn't exist`,
                );
                return { message: 'Payment not found' };
            }

            const targetStatus = dto.status;

            // --- Case A: same status arriving again ---
            // For PROCESSING, this is a retry signal — bump the
            // attempt counter so we have visibility on how many
            // tries this payment is taking. For other statuses
            // it's just an idempotent no-op.
            if (payment.status === targetStatus) {
                if (targetStatus === PaymentStatus.PROCESSING) {
                    payment.attemptCount += 1;
                    await entityManager.save(payment);
                }
                await entityManager.update(
                    WebhookEvent,
                    { eventId: dto.eventId },
                    {
                        processingStatus: WebhookEventStatus.APPLIED,
                        note:
                            targetStatus === PaymentStatus.PROCESSING
                                ? 'Retry attempt recorded'
                                : 'Status already matches — no-op',
                    },
                );
                return {
                    message: 'Webhook applied (no state change needed)',
                    payment: payment.id,
                    status: payment.status,
                };
            }

            // --- Case B: payment is already in a terminal state ---
            // and the webhook is trying to push it somewhere else.
            // Reject loudly; don't silently overwrite money state.
            if (isTerminal(payment.status)) {
                await entityManager.update(
                    WebhookEvent,
                    { eventId: dto.eventId },
                    {
                        processingStatus: WebhookEventStatus.REJECTED,
                        note: `Payment already terminal (${payment.status}), refusing overwrite to ${targetStatus}`,
                    },
                );
                this.logger.error(
                    `Webhook ${dto.eventId} conflicts: payment ${payment.id} is ${payment.status}, webhook says ${targetStatus}`,
                );
                return {
                    message:
                        'Conflicting webhook ignored — payment is already in a final state',
                    paymentStatus: payment.status,
                };
            }

            // --- Case C: not a legal transition ---
            // e.g. PROCESSING -> INITIATED (going backwards)
            if (
                !canTransitionPaymentStatus(
                    payment.status,
                    targetStatus,
                )
            ) {
                await entityManager.update(
                    WebhookEvent,
                    { eventId: dto.eventId },
                    {
                        processingStatus: WebhookEventStatus.REJECTED,
                        note: `Invalid transition ${payment.status} -> ${targetStatus}`,
                    },
                );
                this.logger.error(
                    `Webhook ${dto.eventId}: invalid transition ${payment.status} -> ${targetStatus}`,
                );
                return { message: 'Invalid state transition' };
            }

            // --- Case D: valid transition
            payment.status = targetStatus;

            // Bumping attempt count on the first move to PROCESSING.
            if (targetStatus === PaymentStatus.PROCESSING) {
                payment.attemptCount += 1;
            }

            if (dto.gatewayTransactionId) {
                payment.gatewayTransactionId = dto.gatewayTransactionId;
            }

            if (
                targetStatus === PaymentStatus.FAILED ||
                targetStatus === PaymentStatus.BLOCKED
            ) {
                payment.failureReason = dto.reason ?? 'Set by webhook';
            }

            if (isTerminal(targetStatus)) {
                payment.processedAt = new Date();
            }

            await entityManager.save(payment);

            await entityManager.update(
                WebhookEvent,
                { eventId: dto.eventId },
                { processingStatus: WebhookEventStatus.APPLIED },
            );

            this.logger.log(
                `Webhook ${dto.eventId} applied: payment ${payment.id} ${payment.status === targetStatus ? '' : '-> '}${targetStatus}`,
            );

            return {
                message: 'Webhook processed',
                payment: payment.id,
                status: payment.status,
            };
        });
    }

    /**
     * List webhook events, newest first. Supports paging and an
     * optional filter by paymentId so a frontend can show the audit
     * trail for a single payment.
     */
    async listWebhookEvents(options: {
        limit: number;
        offset: number;
        paymentId?: string;
    }) {
        const eventsRepo = this.dataSource.getRepository(WebhookEvent);

        const queryBuilder = eventsRepo
            .createQueryBuilder('event')
            .orderBy('event.createdAt', 'DESC')
            .take(options.limit)
            .skip(options.offset);

        if (options.paymentId) {
            queryBuilder.where('event.paymentId = :paymentId', {
                paymentId: options.paymentId,
            });
        }

        const [events, total] = await queryBuilder.getManyAndCount();

        return {
            total,
            limit: options.limit,
            offset: options.offset,
            events,
        };
    }

    /**
     * Look up one event by its eventId. 404 if not found.
     */
    async getWebhookEventByEventId(eventId: string) {
        const event = await this.dataSource
            .getRepository(WebhookEvent)
            .findOne({ where: { eventId } });

        if (!event) {
            throw new NotFoundException(
                `No webhook event with eventId=${eventId}`,
            );
        }

        return event;
    }

    /**
     * Used by the controller when signature verification fails. We
     * still want a record of attempted webhooks for an audit trail.
     * ON CONFLICT DO NOTHING — if the same eventId is spammed we just
     * keep the first row, no error, no log spam.
     */
    async recordRejectedWebhookAttempt(
        dto: Partial<WebhookDto>,
        rawBody: Buffer | string,
        note: string,
    ): Promise<void> {
        try {
            await this.dataSource
                .createQueryBuilder()
                .insert()
                .into(WebhookEvent)
                .values({
                    eventId: dto.eventId ?? `unsigned-${Date.now()}`,
                    paymentId: dto.paymentId ?? 'unknown',
                    status: dto.status ?? 'UNKNOWN',
                    payload: this.tryParseJson(rawBody),
                    processingStatus: WebhookEventStatus.REJECTED,
                    note,
                })
                .orIgnore()
                .execute();
        } catch {
            // Auditing should never block the 401 response — swallow.
        }
    }

    private isUniqueViolation(err: unknown): boolean {
        return (
            err instanceof QueryFailedError &&
            (err as any).code === POSTGRES_UNIQUE_VIOLATION_CODE
        );
    }

    private tryParseJson(
        raw: Buffer | string,
    ): Record<string, any> | null {
        try {
            const text = Buffer.isBuffer(raw)
                ? raw.toString('utf8')
                : raw;
            return JSON.parse(text);
        } catch {
            return null;
        }
    }
}
