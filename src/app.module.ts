import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RedisModule } from './common/redis/redis.module';
import { databaseConfig } from './config/database.config';
import { redisConfig } from './config/redis.config';
import { DevModule } from './modules/dev/dev.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

const isProd = process.env.NODE_ENV === 'production';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),

        TypeOrmModule.forRootAsync(databaseConfig),

        BullModule.forRoot({ connection: redisConfig }),
        RedisModule,

        ThrottlerModule.forRoot([
            {
                ttl: Number(process.env.RATE_LIMIT_TTL ?? 60) * 1000,
                limit: Number(process.env.RATE_LIMIT_MAX ?? 60),
            },
        ]),

        PaymentsModule,
        WebhooksModule,

        // /dev/* signing helpers — only when NOT in production
        ...(isProd ? [] : [DevModule]),
    ],

    providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class AppModule {}
