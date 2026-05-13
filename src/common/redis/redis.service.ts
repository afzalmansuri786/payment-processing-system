import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

import { redisConfig } from 'src/config/redis.config';

/**
 * Only delete the key if the caller still owns it. Without this, a
 * worker that stalled past the TTL could come back and DEL a lock
 * that's since been re-acquired by someone else. Classic mistake.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class RedisService implements OnModuleDestroy {
    private readonly logger = new Logger(RedisService.name);
    private readonly redis: Redis;

    constructor() {
        this.redis = new Redis({
            host: redisConfig.host,
            port: redisConfig.port,
            maxRetriesPerRequest: null, // BullMQ wants this
        });
    }

    /**
     * Returns a token on success (pass it back to release). Returns null
     * if the lock is already held.
     */
    async acquireLock(
        key: string,
        ttlSeconds = 30,
    ): Promise<string | null> {
        const token = randomUUID();
        const ok = await this.redis.set(
            key,
            token,
            'EX',
            ttlSeconds,
            'NX',
        );
        return ok === 'OK' ? token : null;
    }

    async releaseLock(key: string, token: string): Promise<void> {
        try {
            await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
        } catch (err: any) {
            this.logger.warn(
                `failed to release lock ${key}: ${err?.message ?? err}`,
            );
        }
    }

    getClient(): Redis {
        return this.redis;
    }

    async onModuleDestroy() {
        await this.redis.quit();
    }
}
