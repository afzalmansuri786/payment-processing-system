import {
    Body,
    Controller,
    Logger,
    Post,
    RawBodyRequest,
    Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createHmac } from 'crypto';
import { Request } from 'express';

import { loadPaymentConfig } from 'src/config/payment.config';

import { WebhookDto } from '../payments/dto/webhook.dto';
import { WebhooksService } from '../webhooks/webhooks.service';

/**
 * Dev-only helpers so the reviewer (and you) don't have to compute
 * HMAC signatures by hand to test the webhook flow. Mounted only when
 * NODE_ENV !== 'production' — see AppModule.
 *
 * Don't ship these to prod. They'd let anyone forge signed webhooks.
 */
@ApiTags('dev')
@Controller('dev')
@SkipThrottle()
export class DevController {
    private readonly logger = new Logger(DevController.name);
    private readonly paymentConfig = loadPaymentConfig();

    constructor(
        private readonly webhooksService: WebhooksService,
    ) {}

    /**
     * Compute the HMAC for a body, but DON'T send it anywhere.
     * Useful when you want to test the actual /webhooks/payment
     * endpoint manually with curl or Postman.
     */
    @Post('sign-webhook')
    @ApiOperation({
        summary: '[DEV] Compute X-Webhook-Signature for a body',
        description:
            'Returns the signature for the exact bytes you sent. Paste it into X-Webhook-Signature when calling /webhooks/payment.',
    })
    signWebhookPayload(
        @Body() body: WebhookDto,
        @Req() req: RawBodyRequest<Request>,
    ) {
        const rawBody =
            req.rawBody ??
            Buffer.from(JSON.stringify(body ?? {}), 'utf8');

        const signature = createHmac(
            'sha256',
            this.paymentConfig.webhookSigningSecret,
        )
            .update(rawBody)
            .digest('hex');

        return {
            signature,
            header: `X-Webhook-Signature: ${signature}`,
            note: 'Use this signature with the EXACT body you posted here. Any whitespace change invalidates it.',
            curl: [
                'curl -X POST http://localhost:3000/webhooks/payment \\',
                `  -H "Content-Type: application/json" \\`,
                `  -H "X-Webhook-Signature: ${signature}" \\`,
                `  --data-binary '${rawBody.toString('utf8')}'`,
            ].join('\n'),
        };
    }

    /**
     * Sign + send in one shot. Server signs your body and runs it
     * through the real webhook pipeline. Identical to a real signed
     * webhook arriving from outside — you just don't have to compute
     * the HMAC yourself.
     */
    @Post('send-webhook')
    @ApiOperation({
        summary: '[DEV] Sign + send a webhook through the real handler',
        description:
            'Server signs the body internally and processes it through verifySignature + handleIncomingWebhook — the same code path /webhooks/payment uses.',
    })
    async signAndSendWebhook(
        @Body() body: WebhookDto,
        @Req() req: RawBodyRequest<Request>,
    ) {
        const rawBody =
            req.rawBody ??
            Buffer.from(JSON.stringify(body ?? {}), 'utf8');

        const signature = createHmac(
            'sha256',
            this.paymentConfig.webhookSigningSecret,
        )
            .update(rawBody)
            .digest('hex');

        this.webhooksService.verifySignature(rawBody, signature);
        const result =
            await this.webhooksService.handleIncomingWebhook(
                body,
                rawBody,
            );

        return {
            note: 'Signed and processed via the real webhook pipeline',
            signature,
            result,
        };
    }
}
