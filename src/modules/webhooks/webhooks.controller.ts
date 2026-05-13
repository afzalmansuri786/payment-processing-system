import {
    Body,
    Controller,
    DefaultValuePipe,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Post,
    Query,
    RawBodyRequest,
    Req,
} from '@nestjs/common';
import {
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';

import { WebhookDto } from '../payments/dto/webhook.dto';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
    constructor(
        private readonly webhooksService: WebhooksService,
    ) {}

    /**
     * The single endpoint where all webhooks arrive — both from real
     * external gateways AND from our own processor doing self-calls.
     * Body must be HMAC-signed; if not, we 401 (and record the
     * rejection for the audit trail).
     *
     * We skip the rate limiter on this endpoint because our own
     * processor sends a burst of self-webhooks per payment, and
     * signature verification is what really gates abuse anyway.
     */
    @Post('payment')
    @HttpCode(HttpStatus.OK)
    @SkipThrottle()
    @ApiOperation({
        summary: 'Receive a gateway / lifecycle webhook',
        description:
            'Body must be signed with HMAC-SHA256 using WEBHOOK_SIGNING_SECRET and the hex digest sent in X-Webhook-Signature.',
    })
    async receiveWebhook(
        @Body() dto: WebhookDto,
        @Headers('x-webhook-signature') signature: string,
        @Req() req: RawBodyRequest<Request>,
    ) {
        // Sign against the actual bytes Express received. Don't
        // re-serialize req.body — that can reorder keys or drop
        // whitespace and break the signature.
        if (!req.rawBody) {
            await this.webhooksService.recordRejectedWebhookAttempt(
                dto,
                Buffer.alloc(0),
                'Raw body not captured (body parser misconfigured)',
            );
            // Same response as a real auth failure so an attacker
            // can't tell the difference.
            this.webhooksService.verifySignature(
                Buffer.alloc(0),
                signature,
            );
        }

        try {
            this.webhooksService.verifySignature(
                req.rawBody as Buffer,
                signature,
            );
        } catch (err) {
            // Log the rejection in webhook_events so you have a
            // paper trail of bad attempts. Then 401.
            await this.webhooksService.recordRejectedWebhookAttempt(
                dto,
                req.rawBody as Buffer,
                'Bad or missing signature',
            );
            throw err;
        }

        return this.webhooksService.handleIncomingWebhook(
            dto,
            req.rawBody as Buffer,
        );
    }

    /**
     * List all webhook events, newest first. Use this to see the
     * full audit trail for a payment (or all payments).
     */
    @Get()
    @ApiOperation({
        summary: 'List webhook events (newest first)',
        description:
            'Returns webhook_events rows, ordered by createdAt DESC. Use the optional paymentId filter to see the audit trail for one specific payment.',
    })
    @ApiQuery({ name: 'limit', required: false, example: 20 })
    @ApiQuery({ name: 'offset', required: false, example: 0 })
    @ApiQuery({
        name: 'paymentId',
        required: false,
        description: 'Filter to a single payment',
    })
    async listWebhookEvents(
        @Query('limit', new DefaultValuePipe(20), ParseIntPipe)
        limit: number,
        @Query('offset', new DefaultValuePipe(0), ParseIntPipe)
        offset: number,
        @Query('paymentId') paymentId?: string,
    ) {
        // Cap limit so a curious user can't ask for a million rows
        const safeLimit = Math.min(Math.max(limit, 1), 100);

        return this.webhooksService.listWebhookEvents({
            limit: safeLimit,
            offset: Math.max(offset, 0),
            paymentId,
        });
    }

    /**
     * Fetch one event by its eventId. Useful when you have a webhook
     * id from a log and want to see what it did.
     */
    @Get(':eventId')
    @ApiOperation({ summary: 'Get one webhook event by eventId' })
    async getWebhookEventByEventId(
        @Param('eventId') eventId: string,
    ) {
        return this.webhooksService.getWebhookEventByEventId(eventId);
    }
}
