/**
 * Lifecycle of a payment.
 *
 *  INITIATED  – row exists in our DB, queued for processing
 *  PROCESSING – worker has picked it up, gateway call in flight
 *  SUCCESS    – terminal, money moved
 *  FAILED     – terminal, gateway rejected or we exhausted retries
 *  BLOCKED    – terminal, gateway flagged as fraud / risk
 */
export enum PaymentStatus {
    INITIATED = 'INITIATED',
    PROCESSING = 'PROCESSING',
    SUCCESS = 'SUCCESS',
    FAILED = 'FAILED',
    BLOCKED = 'BLOCKED',
}

export const TERMINAL_STATUSES: ReadonlySet<PaymentStatus> = new Set([
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.BLOCKED,
]);

export function isTerminal(status: PaymentStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}
