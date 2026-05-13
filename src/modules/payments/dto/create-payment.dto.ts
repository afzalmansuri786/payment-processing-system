import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsPositive, IsString } from 'class-validator';

export class CreatePaymentDto {
    @ApiProperty({
        example: 19999,
        description: 'Amount in minor units (paise / cents)',
    })
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    amount!: number;

    @ApiProperty({ example: 'INR' })
    @IsString()
    @IsIn(['INR', 'USD', 'EUR', 'GBP'])
    currency!: string;
}
