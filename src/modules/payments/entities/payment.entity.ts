import {
    BeforeInsert,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
    UpdateDateColumn,
    VersionColumn,
} from 'typeorm';

import { PaymentStatus } from '../enums/payment-status.enum';

const bigintToNumber = {
    to: (v?: number) => v,
    from: (v: string | null) => (v === null ? null : parseInt(v, 10)),
};

@Entity('payments')
export class Payment {
    @PrimaryColumn()
    id!: string;

    @Column({ type: 'bigint', transformer: bigintToNumber })
    amount!: number;

    @Column({ length: 8 })
    currency!: string;

    @Column({
        type: 'enum',
        enum: PaymentStatus,
        default: PaymentStatus.INITIATED,
    })
    status!: PaymentStatus;

    @Index({ unique: true })
    @Column()
    idempotencyKey!: string;

    @Column({ default: 0 })
    attemptCount!: number;

    @Column({ type: 'varchar', nullable: true })
    gatewayTransactionId!: string | null;

    @Column({ type: 'text', nullable: true })
    failureReason!: string | null;

    @Column({ type: 'timestamptz', nullable: true })
    processedAt!: Date | null;

    @VersionColumn()
    version!: number;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt!: Date;

    @BeforeInsert()
    assignId() {
        if (!this.id) {
            const ts = Date.now();
            const rand = Math.random()
                .toString(36)
                .substring(2, 8)
                .toUpperCase();
            this.id = `PAY_${ts}_${rand}`;
        }
    }
}
