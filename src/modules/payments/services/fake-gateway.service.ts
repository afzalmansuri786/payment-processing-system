import { Injectable, Logger } from '@nestjs/common';

import {
    NonRetriableGatewayError,
    TransientGatewayError,
} from 'src/common/exceptions/gateway-errors';
import { loadPaymentConfig } from 'src/config/payment.config';

import { PaymentStatus } from '../enums/payment-status.enum';
import { GatewayResponse } from '../interfaces/gateway-response.interface';
import { CircuitBreakerService } from './circuit-breaker.service';

/**
 * Outcome weights (roughly):
 *   55% — clean success
 *   15% — declined (terminal, don't retry)
 *    5% — fraud block (terminal, don't retry)
 *   15% — transient 502 (retry)
 *   10% — timeout (retry)
 *
 * `run` is synchronous. Success returns the response, failures throw.
 * Throwing functions have return type `never`, which is assignable to
 * GatewayResponse, so the discriminated union resolves cleanly.
 */
interface GatewayOutcome {
    weight: number;
    run: () => GatewayResponse;
}

@Injectable()
export class FakeGatewayService {
    private readonly logger = new Logger(FakeGatewayService.name);
    private readonly timeoutMs: number;

    constructor(private readonly breaker: CircuitBreakerService) {
        this.timeoutMs = loadPaymentConfig().gatewayTimeoutMs;
    }

    async processPayment(paymentId: string): Promise<GatewayResponse> {
        return this.breaker.exec(() => this.callRemote(paymentId));
    }

    private async callRemote(paymentId: string): Promise<GatewayResponse> {
        // Fake some network latency, 200ms – 1.8s.
        const latencyMs = 200 + Math.floor(Math.random() * 1600);

        // Hard timeout via AbortController so we don't hang forever
        // if the (fake) remote stalls past our budget.
        const aborter = new AbortController();
        const killTimer = setTimeout(
            () => aborter.abort(),
            this.timeoutMs,
        );

        try {
            await this.wait(latencyMs, aborter.signal);
        } catch {
            this.logger.warn(
                `gateway timed out after ${this.timeoutMs}ms for ${paymentId}`,
            );
            throw new TransientGatewayError('Gateway timeout');
        } finally {
            clearTimeout(killTimer);
        }

        return this.pickOutcome();
    }

    private pickOutcome(): GatewayResponse {
        const outcomes: GatewayOutcome[] = [
            { weight: 55, run: () => this.outcomeSuccess() },
            { weight: 15, run: () => this.outcomeDeclined() },
            { weight: 5, run: () => this.outcomeBlocked() },
            { weight: 15, run: () => this.outcomeTransient() },
            { weight: 10, run: () => this.outcomeTimeout() },
        ];

        const totalWeight = outcomes.reduce(
            (sum, o) => sum + o.weight,
            0,
        );

        let roll = Math.random() * totalWeight;

        for (const outcome of outcomes) {
            roll -= outcome.weight;
            if (roll <= 0) return outcome.run();
        }

        // shouldn't happen, but TS wants a return
        return outcomes[0].run();
    }

    private outcomeSuccess(): GatewayResponse {
        return {
            status: PaymentStatus.SUCCESS,
            message: 'Payment approved',
            transactionId: this.generateTransactionId(),
            timestamp: new Date().toISOString(),
        };
    }

    private outcomeDeclined(): never {
        throw new NonRetriableGatewayError(
            'Payment declined by issuer (insufficient funds / invalid card)',
            'FAILED',
        );
    }

    private outcomeBlocked(): never {
        throw new NonRetriableGatewayError(
            'Transaction blocked by fraud rules',
            'BLOCKED',
        );
    }

    private outcomeTransient(): never {
        throw new TransientGatewayError(
            'Gateway 502: upstream issuer unreachable',
        );
    }

    private outcomeTimeout(): never {
        throw new TransientGatewayError('Gateway read timeout');
    }

    private generateTransactionId(): string {
        return `TXN-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    private wait(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                return reject(new Error('aborted'));
            }
            const timer = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            });
        });
    }
}
