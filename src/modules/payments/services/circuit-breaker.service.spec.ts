import { CircuitBreakerOpenError } from 'src/common/exceptions/gateway-errors';

import { CircuitBreakerService } from './circuit-breaker.service';

describe('CircuitBreakerService', () => {
    const PREV_ENV = process.env;

    beforeEach(() => {
        process.env = { ...PREV_ENV };
        process.env.CB_FAILURE_THRESHOLD = '3';
        process.env.CB_OPEN_DURATION_MS = '50';
    });

    afterEach(() => {
        process.env = PREV_ENV;
    });

    it('stays closed while calls succeed', async () => {
        const breaker = new CircuitBreakerService();
        for (let i = 0; i < 10; i++) {
            await breaker.exec(async () => 'ok');
        }
        expect(breaker.getState()).toBe('CLOSED');
    });

    it('opens after the failure threshold and short-circuits', async () => {
        const breaker = new CircuitBreakerService();
        const failingCall = () =>
            Promise.reject(new Error('boom'));

        for (let i = 0; i < 3; i++) {
            await expect(breaker.exec(failingCall)).rejects.toThrow(
                'boom',
            );
        }

        expect(breaker.getState()).toBe('OPEN');
        await expect(
            breaker.exec(failingCall),
        ).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    });

    it('moves to half-open after cooldown and closes on a successful probe', async () => {
        const breaker = new CircuitBreakerService();

        for (let i = 0; i < 3; i++) {
            await expect(
                breaker.exec(() =>
                    Promise.reject(new Error('boom')),
                ),
            ).rejects.toThrow('boom');
        }

        expect(breaker.getState()).toBe('OPEN');
        await new Promise((r) => setTimeout(r, 60));
        await breaker.exec(async () => 'ok');
        expect(breaker.getState()).toBe('CLOSED');
    });
});
