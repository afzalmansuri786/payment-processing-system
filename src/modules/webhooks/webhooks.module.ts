import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Payment } from '../payments/entities/payment.entity';
import { WebhookEvent } from '../payments/entities/webhook-event.entity';
import { InternalWebhookEmitterService } from './internal-webhook-emitter.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
    imports: [TypeOrmModule.forFeature([Payment, WebhookEvent])],
    controllers: [WebhooksController],
    providers: [WebhooksService, InternalWebhookEmitterService],
    exports: [WebhooksService, InternalWebhookEmitterService],
})
export class WebhooksModule {}
