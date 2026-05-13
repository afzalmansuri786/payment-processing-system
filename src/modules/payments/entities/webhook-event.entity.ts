import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

export enum WebhookEventStatus {
    RECEIVED = 'RECEIVED',
    APPLIED = 'APPLIED',
    BUFFERED = 'BUFFERED', // payment not ready, replay later
    REJECTED = 'REJECTED', // conflict / bad signature / unknown payment
}

@Entity('webhook_events')
export class WebhookEvent {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index({ unique: true })
    @Column()
    eventId!: string;

    @Index()
    @Column()
    paymentId!: string;

    @Column()
    status!: string; // status reported by gateway

    @Column({
        type: 'enum',
        enum: WebhookEventStatus,
        default: WebhookEventStatus.RECEIVED,
    })
    processingStatus!: WebhookEventStatus;

    @Column({ type: 'jsonb', nullable: true })
    payload!: Record<string, any> | null;

    @Column({ type: 'text', nullable: true })
    note!: string | null;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;
}
