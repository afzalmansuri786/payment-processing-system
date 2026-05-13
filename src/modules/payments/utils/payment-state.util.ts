import { PaymentStatus } from '../enums/payment-status.enum';

/**
 * Where each status is allowed to move next.
 *
 * INITIATED can jump straight to a terminal state because external
 * gateways sometimes send a callback BEFORE our worker has even
 * started running. The assignment calls these "early callbacks" and
 * specifically asks us to handle them.
 *
 * PROCESSING -> PROCESSING is allowed because the same status arriving
 * twice (e.g. a retry signal) shouldn't be rejected — the handler treats
 * it as an idempotent no-op (or, for PROCESSING, an attempt-count bump).
 */
const allowedTransitions: Record<PaymentStatus, PaymentStatus[]> = {
    [PaymentStatus.INITIATED]: [
        PaymentStatus.PROCESSING,
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.BLOCKED,
    ],

    [PaymentStatus.PROCESSING]: [
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.BLOCKED,
    ],

    // Terminal — these don't move anywhere
    [PaymentStatus.SUCCESS]: [],
    [PaymentStatus.FAILED]: [],
    [PaymentStatus.BLOCKED]: [],
};

export function canTransitionPaymentStatus(
    currentStatus: PaymentStatus,
    nextStatus: PaymentStatus,
): boolean {
    // Same status = ok, treated as a no-op upstream
    if (currentStatus === nextStatus) return true;
    return allowedTransitions[currentStatus]?.includes(nextStatus) ?? false;
}
