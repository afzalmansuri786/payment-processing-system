import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

import { PaymentStatus } from '../enums/payment-status.enum';

/**
 * Shape of any webhook the system accepts at POST /webhooks/payment.
 *
 * Both external gateways AND our own internal processor send this same
 * shape — so the field accepts every lifecycle status, not just the
 * terminal ones. The handler decides what's actually a valid transition.
 */
export class WebhookDto {
    @ApiProperty({ example: 'evt_01HXYZ', description: 'Unique id for this event (used for dedup)' })
    @IsString()
    eventId!: string;

    @ApiProperty({ example: 'PAY_1700000000000_ABC123' })
    @IsString()
    paymentId!: string;

    @ApiProperty({
        enum: PaymentStatus,
        description: 'Where the payment is now / should move to',
    })
    @IsIn([
        PaymentStatus.INITIATED,
        PaymentStatus.PROCESSING,
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.BLOCKED,
    ])
    status!: PaymentStatus;

    @ApiProperty({ required: false, example: 'TXN-1700000000000-12345' })
    @IsOptional()
    @IsString()
    gatewayTransactionId?: string;

    @ApiProperty({ required: false, description: 'Why it failed (only for FAILED / BLOCKED)' })
    @IsOptional()
    @IsString()
    reason?: string;
}
