import { PaymentStatus } from '../enums/payment-status.enum';
import { canTransitionPaymentStatus } from './payment-state.util';

describe('canTransitionPaymentStatus', () => {
    it('allows the normal happy path', () => {
        expect(
            canTransitionPaymentStatus(
                PaymentStatus.INITIATED,
                PaymentStatus.PROCESSING,
            ),
        ).toBe(true);

        expect(
            canTransitionPaymentStatus(
                PaymentStatus.PROCESSING,
                PaymentStatus.SUCCESS,
            ),
        ).toBe(true);
    });

    it('allows early webhooks: INITIATED -> SUCCESS/FAILED/BLOCKED', () => {
        expect(
            canTransitionPaymentStatus(
                PaymentStatus.INITIATED,
                PaymentStatus.SUCCESS,
            ),
        ).toBe(true);
        expect(
            canTransitionPaymentStatus(
                PaymentStatus.INITIATED,
                PaymentStatus.FAILED,
            ),
        ).toBe(true);
        expect(
            canTransitionPaymentStatus(
                PaymentStatus.INITIATED,
                PaymentStatus.BLOCKED,
            ),
        ).toBe(true);
    });

    it('treats same-state transitions as no-ops', () => {
        expect(
            canTransitionPaymentStatus(
                PaymentStatus.SUCCESS,
                PaymentStatus.SUCCESS,
            ),
        ).toBe(true);
    });

    it('blocks anything leaving a terminal state', () => {
        const terminalStatuses = [
            PaymentStatus.SUCCESS,
            PaymentStatus.FAILED,
            PaymentStatus.BLOCKED,
        ];

        for (const terminal of terminalStatuses) {
            expect(
                canTransitionPaymentStatus(
                    terminal,
                    PaymentStatus.PROCESSING,
                ),
            ).toBe(false);

            expect(
                canTransitionPaymentStatus(
                    terminal,
                    PaymentStatus.INITIATED,
                ),
            ).toBe(false);
        }
    });

    it('blocks PROCESSING going backwards to INITIATED', () => {
        expect(
            canTransitionPaymentStatus(
                PaymentStatus.PROCESSING,
                PaymentStatus.INITIATED,
            ),
        ).toBe(false);
    });
});
