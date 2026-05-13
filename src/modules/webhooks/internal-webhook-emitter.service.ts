import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';

import { loadPaymentConfig } from 'src/config/payment.config';

import { PaymentStatus } from '../payments/enums/payment-status.enum';

interface EmitInternalWebhookOptions {
    paymentId: string;
    status: PaymentStatus;
    gatewayTransactionId?: string;
    reason?: string;
}

/**
 * Sends webhooks from US to OUR OWN /webhooks/payment endpoint.
 *
 * The fake gateway never actually calls us back (it's just a function
 * in-process), so the processor takes its result, packages it up like
 * a real gateway webhook, signs it, and POSTs it to our own endpoint.
 *
 * The advantage: every payment state change goes through the exact
 * same code path — sig check, dedup, transaction, state machine — as a
 * real external webhook would. Audit trail in webhook_events is
 * automatic. No special "internal" code path to maintain.
 */
@Injectable()
export class InternalWebhookEmitterService {
    private readonly logger = new Logger(
        InternalWebhookEmitterService.name,
    );
    private readonly paymentConfig = loadPaymentConfig();
    private readonly selfBaseUrl: string;

    constructor() {
        const port = process.env.PORT ?? '3000';
        this.selfBaseUrl = `http://127.0.0.1:${port}`;
    }

    /**
     * Build the payload, sign it, POST it to ourselves. Fire-and-forget
     * — if the self-call fails for any reason we log it but don't
     * propagate, because the caller (processor or service) is usually
     * in the middle of something it can't easily roll back.
     */
    async emitWebhookForPayment(
        options: EmitInternalWebhookOptions,
    ): Promise<void> {
        const eventId = `internal-${randomUUID()}`;

        // Trim out empty optional fields so the payload stays clean
        const payload: Record<string, string> = {
            eventId,
            paymentId: options.paymentId,
            status: options.status,
        };
        if (options.gatewayTransactionId) {
            payload.gatewayTransactionId = options.gatewayTransactionId;
        }
        if (options.reason) {
            payload.reason = options.reason;
        }

        const requestBody = JSON.stringify(payload);

        // Same signing scheme an external gateway would use
        const signature = createHmac(
            'sha256',
            this.paymentConfig.webhookSigningSecret,
        )
            .update(requestBody)
            .digest('hex');

        try {
            const response = await fetch(
                `${this.selfBaseUrl}/webhooks/payment`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Signature': signature,
                    },
                    body: requestBody,
                },
            );

            if (!response.ok) {
                const body = await response.text();
                this.logger.warn(
                    `Self-webhook for ${options.paymentId} (${options.status}) returned HTTP ${response.status}: ${body}`,
                );
            } else {
                this.logger.log(
                    `Emitted ${options.status} self-webhook for ${options.paymentId} (eventId=${eventId})`,
                );
            }
        } catch (err: any) {
            // Network error talking to ourselves — only happens if the
            // server is shutting down. Log and move on.
            this.logger.error(
                `Failed to emit ${options.status} self-webhook for ${options.paymentId}: ${err?.message ?? err}`,
            );
        }
    }
}
