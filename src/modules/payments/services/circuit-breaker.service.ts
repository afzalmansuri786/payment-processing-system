import { Injectable, Logger } from '@nestjs/common';

import { CircuitBreakerOpenError } from 'src/common/exceptions/gateway-errors';
import { loadPaymentConfig } from 'src/config/payment.config';

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Tiny in-process circuit breaker for the fake gateway.
 *
 *   CLOSED    – normal operation, counting failures
 *   OPEN      – calls short-circuited, fail fast
 *   HALF_OPEN – cooldown elapsed, send one probe; success closes,
 *               failure re-opens
 */
@Injectable()
export class CircuitBreakerService {
    private readonly logger = new Logger(CircuitBreakerService.name);
    private readonly failureThreshold: number;
    private readonly openDurationMs: number;

    private state: BreakerState = 'CLOSED';
    private failureCount = 0;
    private openedAt = 0;

    constructor() {
        const cfg = loadPaymentConfig();
        this.failureThreshold = cfg.circuitBreakerFailureThreshold;
        this.openDurationMs = cfg.circuitBreakerOpenMs;
    }

    async exec<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === 'OPEN') {
            const elapsed = Date.now() - this.openedAt;
            if (elapsed >= this.openDurationMs) {
                this.state = 'HALF_OPEN';
                this.logger.warn('breaker -> HALF_OPEN (probing)');
            } else {
                throw new CircuitBreakerOpenError();
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (err) {
            this.onFailure();
            throw err;
        }
    }

    private onSuccess() {
        if (this.state !== 'CLOSED') {
            this.logger.log(
                `breaker recovering: ${this.state} -> CLOSED`,
            );
        }
        this.state = 'CLOSED';
        this.failureCount = 0;
    }

    private onFailure() {
        this.failureCount++;

        if (this.state === 'HALF_OPEN') {
            // probe failed, back to OPEN
            this.state = 'OPEN';
            this.openedAt = Date.now();
            this.logger.warn('breaker probe failed, OPEN again');
            return;
        }

        if (
            this.state === 'CLOSED' &&
            this.failureCount >= this.failureThreshold
        ) {
            this.state = 'OPEN';
            this.openedAt = Date.now();
            this.logger.error(
                `breaker OPEN after ${this.failureCount} consecutive failures`,
            );
        }
    }

    getState(): BreakerState {
        return this.state;
    }
}
