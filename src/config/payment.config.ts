export interface PaymentConfig {
    maxAttempts: number;
    backoffInitialMs: number;
    lockTtlSeconds: number;
    gatewayTimeoutMs: number;
    circuitBreakerFailureThreshold: number;
    circuitBreakerOpenMs: number;
    webhookSigningSecret: string;
}

export function loadPaymentConfig(): PaymentConfig {
    return {
        maxAttempts: readIntEnv('PAYMENT_MAX_ATTEMPTS', 4),
        backoffInitialMs: readIntEnv('PAYMENT_BACKOFF_INITIAL_MS', 2000),
        lockTtlSeconds: readIntEnv('PAYMENT_LOCK_TTL_SECONDS', 60),
        gatewayTimeoutMs: readIntEnv('GATEWAY_TIMEOUT_MS', 5000),
        circuitBreakerFailureThreshold: readIntEnv(
            'CB_FAILURE_THRESHOLD',
            5,
        ),
        circuitBreakerOpenMs: readIntEnv('CB_OPEN_DURATION_MS', 20000),
        webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET || '',
    };
}

function readIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
