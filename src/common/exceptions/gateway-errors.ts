/**
 * Thrown for transient stuff — timeouts, 5xx, network blips.
 * Processor lets BullMQ retry these.
 */
export class TransientGatewayError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TransientGatewayError';
    }
}

/**
 * Thrown when the gateway told us "no, and don't bother asking again"
 * — card declined, fraud block, invalid account. Processor marks the
 * payment terminal and does NOT rethrow, so BullMQ doesn't burn the
 * retry budget.
 */
export class NonRetriableGatewayError extends Error {
    constructor(
        message: string,
        public readonly finalStatus: 'FAILED' | 'BLOCKED',
    ) {
        super(message);
        this.name = 'NonRetriableGatewayError';
    }
}

/**
 * Circuit breaker is open and refusing to call the gateway. Treated
 * as transient — when the breaker resets we want to try again.
 */
export class CircuitBreakerOpenError extends TransientGatewayError {
    constructor() {
        super('Circuit breaker is open — gateway calls are temporarily refused');
        this.name = 'CircuitBreakerOpenError';
    }
}
