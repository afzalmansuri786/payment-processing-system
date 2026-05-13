import {
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import { QueryFailedError } from 'typeorm';

import { Payment } from '../payments/entities/payment.entity';
import { WebhookEvent } from '../payments/entities/webhook-event.entity';
import { PaymentStatus } from '../payments/enums/payment-status.enum';
import { WebhooksService } from './webhooks.service';

const TEST_SECRET =
    'dev-secret-please-change-me-in-prod-1234567890abcdef';

function signBody(body: object): { rawBody: Buffer; signature: string } {
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const signature = createHmac('sha256', TEST_SECRET)
        .update(rawBody)
        .digest('hex');
    return { rawBody, signature };
}

/**
 * Build a tiny in-memory stand-in for the DataSource. Only mocks
 * the bits the WebhooksService actually touches.
 */
function buildFakeDataSource(
    initialPayment: Partial<Payment> | null,
) {
    let storedPayment: Partial<Payment> | null = initialPayment
        ? { ...initialPayment }
        : null;
    const insertedEvents: any[] = [];
    let forceDuplicateInsertOnce = false;

    const fakeEventsRepository = {
        insert: jest.fn(async (event: any) => {
            if (forceDuplicateInsertOnce) {
                forceDuplicateInsertOnce = false;
                const err: any = new QueryFailedError(
                    'insert',
                    [],
                    new Error('dup'),
                );
                err.code = '23505';
                throw err;
            }
            insertedEvents.push(event);
            return { identifiers: [{ id: 'evt-row' }] };
        }),
        createQueryBuilder: jest.fn(() => ({
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getManyAndCount: jest.fn(async () => [
                insertedEvents,
                insertedEvents.length,
            ]),
        })),
        findOne: jest.fn(async (opts: any) => {
            return (
                insertedEvents.find(
                    (e) => e.eventId === opts?.where?.eventId,
                ) ?? null
            );
        }),
    };

    const fakeDataSource = {
        getRepository: jest.fn((entity: any) => {
            if (entity === WebhookEvent) return fakeEventsRepository;
            throw new Error('Unexpected entity in getRepository');
        }),
        createQueryBuilder: jest.fn(() => ({
            insert: jest.fn().mockReturnThis(),
            into: jest.fn().mockReturnThis(),
            values: jest.fn().mockReturnThis(),
            orIgnore: jest.fn().mockReturnThis(),
            execute: jest.fn(async () => ({ identifiers: [] })),
        })),
        transaction: jest.fn(
            async (cb: (em: any) => Promise<any>) => {
                const fakeEntityManager = {
                    findOne: jest.fn(async (entity: any) => {
                        if (entity === Payment) return storedPayment;
                        return null;
                    }),
                    save: jest.fn(async (payment: any) => {
                        storedPayment = {
                            ...storedPayment,
                            ...payment,
                        };
                        return storedPayment;
                    }),
                    update: jest.fn(async () => undefined),
                };
                return cb(fakeEntityManager);
            },
        ),
        __setPayment: (p: Partial<Payment> | null) => {
            storedPayment = p ? { ...p } : null;
        },
        __getPayment: () => storedPayment,
        __forceDuplicateInsert: () => {
            forceDuplicateInsertOnce = true;
        },
        __insertedEvents: insertedEvents,
    };
    return fakeDataSource;
}

describe('WebhooksService', () => {
    let webhooksService: WebhooksService;
    let fakeDataSource: ReturnType<typeof buildFakeDataSource>;
    const PREVIOUS_SECRET = process.env.WEBHOOK_SIGNING_SECRET;

    beforeAll(() => {
        process.env.WEBHOOK_SIGNING_SECRET = TEST_SECRET;
    });

    afterAll(() => {
        process.env.WEBHOOK_SIGNING_SECRET = PREVIOUS_SECRET;
    });

    beforeEach(async () => {
        fakeDataSource = buildFakeDataSource({
            id: 'PAY_1',
            status: PaymentStatus.INITIATED,
            attemptCount: 0,
            gatewayTransactionId: null,
            failureReason: null,
            processedAt: null,
        });

        const moduleRef: TestingModule =
            await Test.createTestingModule({
                providers: [
                    WebhooksService,
                    {
                        provide: getDataSourceToken(),
                        useValue: fakeDataSource,
                    },
                ],
            }).compile();

        webhooksService = moduleRef.get(WebhooksService);
    });

    describe('signature verification', () => {
        it('rejects a webhook with no signature', () => {
            expect(() =>
                webhooksService.verifySignature(
                    Buffer.from('{}'),
                    undefined,
                ),
            ).toThrow(UnauthorizedException);
        });

        it('rejects a webhook with a wrong signature', () => {
            expect(() =>
                webhooksService.verifySignature(
                    Buffer.from('{}'),
                    'deadbeef'.repeat(8),
                ),
            ).toThrow(UnauthorizedException);
        });

        it('accepts a correctly signed payload', () => {
            const { rawBody, signature } = signBody({
                hello: 'world',
            });
            expect(() =>
                webhooksService.verifySignature(rawBody, signature),
            ).not.toThrow();
        });
    });

    describe('handleIncomingWebhook', () => {
        it('applies an early webhook (INITIATED -> SUCCESS)', async () => {
            const body = {
                eventId: 'evt-1',
                paymentId: 'PAY_1',
                status: PaymentStatus.SUCCESS,
                gatewayTransactionId: 'TXN-1',
            };

            const result: any =
                await webhooksService.handleIncomingWebhook(
                    body as any,
                    Buffer.from(JSON.stringify(body)),
                );

            expect(result.status).toBe(PaymentStatus.SUCCESS);
            expect(fakeDataSource.__getPayment()?.status).toBe(
                PaymentStatus.SUCCESS,
            );
        });

        it('ignores a duplicate webhook (same eventId)', async () => {
            fakeDataSource.__forceDuplicateInsert();
            const body = {
                eventId: 'evt-1',
                paymentId: 'PAY_1',
                status: PaymentStatus.SUCCESS,
            };

            const result: any =
                await webhooksService.handleIncomingWebhook(
                    body as any,
                    Buffer.from(JSON.stringify(body)),
                );

            expect(result.duplicate).toBe(true);
        });

        it('refuses to overwrite a terminal payment (conflicting webhook)', async () => {
            fakeDataSource.__setPayment({
                id: 'PAY_1',
                status: PaymentStatus.SUCCESS,
                attemptCount: 1,
                gatewayTransactionId: 'TXN-OK',
                failureReason: null,
                processedAt: new Date(),
            });

            const body = {
                eventId: 'evt-conflict',
                paymentId: 'PAY_1',
                status: PaymentStatus.FAILED,
            };

            const result: any =
                await webhooksService.handleIncomingWebhook(
                    body as any,
                    Buffer.from(JSON.stringify(body)),
                );

            expect(result.message).toMatch(/conflicting/i);
            expect(fakeDataSource.__getPayment()?.status).toBe(
                PaymentStatus.SUCCESS,
            );
        });

        it('bumps attemptCount on PROCESSING-to-PROCESSING (retry signal)', async () => {
            fakeDataSource.__setPayment({
                id: 'PAY_1',
                status: PaymentStatus.PROCESSING,
                attemptCount: 1,
                gatewayTransactionId: null,
                failureReason: null,
                processedAt: null,
            });

            const body = {
                eventId: 'evt-retry',
                paymentId: 'PAY_1',
                status: PaymentStatus.PROCESSING,
            };

            await webhooksService.handleIncomingWebhook(
                body as any,
                Buffer.from(JSON.stringify(body)),
            );

            expect(
                fakeDataSource.__getPayment()?.attemptCount,
            ).toBe(2);
        });

        it('rejects webhooks for unknown payments', async () => {
            fakeDataSource.__setPayment(null);

            const body = {
                eventId: 'evt-ghost',
                paymentId: 'PAY_GHOST',
                status: PaymentStatus.SUCCESS,
            };

            const result: any =
                await webhooksService.handleIncomingWebhook(
                    body as any,
                    Buffer.from(JSON.stringify(body)),
                );

            expect(result.message).toMatch(/not found/i);
        });
    });

    describe('list and lookup', () => {
        it('throws NotFound for an unknown eventId', async () => {
            await expect(
                webhooksService.getWebhookEventByEventId(
                    'evt-does-not-exist',
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
