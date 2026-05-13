import { getQueueToken } from '@nestjs/bullmq';
import {
    BadRequestException,
    NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';

import { InternalWebhookEmitterService } from '../../webhooks/internal-webhook-emitter.service';
import { Payment } from '../entities/payment.entity';
import { PaymentStatus } from '../enums/payment-status.enum';
import { PaymentsService } from './payments.service';

function buildFakePaymentRepository() {
    return {
        findOne: jest.fn(),
        findOneOrFail: jest.fn(),
        create: jest.fn((x: any) => x),
        save: jest.fn(),
    };
}

function buildFakePaymentQueue() {
    return { add: jest.fn().mockResolvedValue(undefined) };
}

function buildFakeWebhookEmitter() {
    return {
        emitWebhookForPayment: jest.fn().mockResolvedValue(undefined),
    };
}

describe('PaymentsService', () => {
    let paymentsService: PaymentsService;
    let paymentRepository: ReturnType<typeof buildFakePaymentRepository>;
    let paymentQueue: ReturnType<typeof buildFakePaymentQueue>;
    let webhookEmitter: ReturnType<typeof buildFakeWebhookEmitter>;

    beforeEach(async () => {
        paymentRepository = buildFakePaymentRepository();
        paymentQueue = buildFakePaymentQueue();
        webhookEmitter = buildFakeWebhookEmitter();

        const moduleRef: TestingModule =
            await Test.createTestingModule({
                providers: [
                    PaymentsService,
                    {
                        provide: getRepositoryToken(Payment),
                        useValue: paymentRepository,
                    },
                    {
                        provide: getQueueToken('payment-queue'),
                        useValue: paymentQueue,
                    },
                    {
                        provide: InternalWebhookEmitterService,
                        useValue: webhookEmitter,
                    },
                ],
            }).compile();

        paymentsService = moduleRef.get(PaymentsService);
    });

    it('rejects requests without an idempotency key', async () => {
        await expect(
            paymentsService.createPayment(
                { amount: 100, currency: 'INR' },
                '',
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns the existing payment on idempotent replay', async () => {
        paymentRepository.findOne.mockResolvedValueOnce({
            id: 'PAY_X',
            amount: 100,
            currency: 'INR',
            status: PaymentStatus.SUCCESS,
            attemptCount: 1,
            idempotencyKey: 'key-1',
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        const result = await paymentsService.createPayment(
            { amount: 100, currency: 'INR' },
            'key-1',
        );

        expect(result.payment.id).toBe('PAY_X');
        expect(paymentRepository.save).not.toHaveBeenCalled();
        expect(paymentQueue.add).not.toHaveBeenCalled();
        expect(
            webhookEmitter.emitWebhookForPayment,
        ).not.toHaveBeenCalled();
    });

    it('creates a fresh payment, emits INITIATED webhook, and enqueues it', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(null);
        paymentRepository.save.mockResolvedValueOnce({
            id: 'PAY_NEW',
            amount: 100,
            currency: 'INR',
            status: PaymentStatus.INITIATED,
            attemptCount: 0,
            idempotencyKey: 'key-2',
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        const result = await paymentsService.createPayment(
            { amount: 100, currency: 'INR' },
            'key-2',
        );

        expect(result.payment.id).toBe('PAY_NEW');
        expect(paymentQueue.add).toHaveBeenCalledTimes(1);
        expect(
            webhookEmitter.emitWebhookForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 'PAY_NEW',
            status: PaymentStatus.INITIATED,
        });
    });

    it('survives the idempotency race (unique violation -> refetch)', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(null);

        const duplicateError: any = new QueryFailedError(
            'insert',
            [],
            new Error('dup'),
        );
        duplicateError.code = '23505';
        paymentRepository.save.mockRejectedValueOnce(duplicateError);

        paymentRepository.findOneOrFail.mockResolvedValueOnce({
            id: 'PAY_WINNER',
            amount: 100,
            currency: 'INR',
            status: PaymentStatus.INITIATED,
            attemptCount: 0,
            idempotencyKey: 'key-3',
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        const result = await paymentsService.createPayment(
            { amount: 100, currency: 'INR' },
            'key-3',
        );

        expect(result.payment.id).toBe('PAY_WINNER');
        expect(paymentQueue.add).not.toHaveBeenCalled();
    });

    it('returns sanitized payment via getPayment', async () => {
        paymentRepository.findOne.mockResolvedValueOnce({
            id: 'PAY_X',
            amount: 100,
            currency: 'INR',
            status: PaymentStatus.SUCCESS,
            idempotencyKey: 'should-not-leak',
            attemptCount: 1,
            gatewayTransactionId: 'TXN-1',
            failureReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        const result: any = await paymentsService.getPayment('PAY_X');

        expect(result.payment.id).toBe('PAY_X');
        expect(result.payment).not.toHaveProperty('idempotencyKey');
    });

    it('throws NotFound for an unknown payment id', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(null);
        await expect(
            paymentsService.getPayment('PAY_GHOST'),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});
