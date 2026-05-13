import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { CreatePaymentDto } from '../dto/create-payment.dto';
import { PaymentsService } from '../services/payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) {}

    @Post()
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Initiate a payment',
        description:
            'Creates a payment and enqueues it for async processing. Pass the same Idempotency-Key on retries to dedupe.',
    })
    async createPayment(
        @Body() dto: CreatePaymentDto,
        @Headers('idempotency-key') idempotencyKey: string,
    ) {
        return this.paymentsService.createPayment(dto, idempotencyKey);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get payment status' })
    @ApiParam({ name: 'id', example: 'PAY_1700000000000_ABC123' })
    async getPayment(@Param('id') id: string) {
        return this.paymentsService.getPayment(id);
    }
}
