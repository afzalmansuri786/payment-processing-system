export const redisConfig = {
    host: process.env.REDIS_HOST?.trim() || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
};
