import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { WinstonModule } from 'nest-winston';

import { AppModule } from './app.module';
import { winstonConfig } from './common/logger/winston.config';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(
        AppModule,
        {
            logger: WinstonModule.createLogger(winstonConfig),
            // Required so the webhook controller can verify HMAC
            // against the exact bytes Express received, instead of
            // re-serializing req.body (which loses whitespace and
            // can reorder keys, breaking the signature check).
            rawBody: true,
        },
    );

    /**
     * Capture raw request body so the webhook controller can verify
     * the HMAC against exactly what arrived on the wire.
     */
    app.use(
        json({
            verify: (req: any, _res, buf) => {
                req.rawBody = buf;
            },
        }),
    );

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    );

    const swaggerCfg = new DocumentBuilder()
        .setTitle('Payment Processing System')
        .setDescription(
            'Backend assignment — payment lifecycle, retries, idempotency, webhooks.',
        )
        .setVersion('0.1.0')
        .addTag('payments')
        .addTag('webhooks')
        .build();

    const document = SwaggerModule.createDocument(app, swaggerCfg);
    SwaggerModule.setup('api/docs', app, document);

    const port = Number(process.env.PORT) || 3000;
    await app.listen(port);

    // eslint-disable-next-line no-console
    console.log(
        `Listening on http://localhost:${port}  |  Docs: /api/docs`,
    );
}

bootstrap();
