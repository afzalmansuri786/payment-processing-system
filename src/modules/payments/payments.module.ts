import { BullModule } from '@nestjs/bullmq';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { redisConfig } from 'src/config/redis.config';

import { WebhooksModule } from '../webhooks/webhooks.module';
import { PaymentsController } from './controllers/payments.controller';
import { Payment } from './entities/payment.entity';
import { WebhookEvent } from './entities/webhook-event.entity';
import { PaymentProcessor } from './processors/payment.processor';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { FakeGatewayService } from './services/fake-gateway.service';
import { PaymentsService } from './services/payments.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([Payment, WebhookEvent]),
        BullModule.registerQueue({
            name: 'payment-queue',
            connection: redisConfig,
        }),
        // Need the InternalWebhookEmitterService so the processor
        // and the service can emit self-webhooks.
        forwardRef(() => WebhooksModule),
    ],

    controllers: [PaymentsController],

    providers: [
        PaymentsService,
        PaymentProcessor,
        FakeGatewayService,
        CircuitBreakerService,
    ],

    exports: [PaymentsService],
})
export class PaymentsModule {}
