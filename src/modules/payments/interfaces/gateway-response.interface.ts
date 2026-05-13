import { PaymentStatus } from '../enums/payment-status.enum';

export interface GatewayResponse {
    status:
        | PaymentStatus.SUCCESS
        | PaymentStatus.FAILED
        | PaymentStatus.BLOCKED;
    message: string;
    transactionId: string;
    timestamp: string;
}
