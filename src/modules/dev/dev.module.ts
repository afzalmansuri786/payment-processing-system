import { Module } from '@nestjs/common';

import { WebhooksModule } from '../webhooks/webhooks.module';
import { DevController } from './dev.controller';

/**
 * DEV-ONLY module. Conditionally imported by AppModule when
 * NODE_ENV !== 'production'. Exposes signing helpers under /dev/*.
 */
@Module({
    imports: [WebhooksModule],
    controllers: [DevController],
})
export class DevModule {}
