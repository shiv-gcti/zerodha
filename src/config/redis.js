import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || '6379'}`;

const redisOptions = {
    url: redisUrl,
    socket: {
        reconnectStrategy: (retries) => Math.min(retries * 1000, 5000),
    }
};

if (process.env.REDIS_PASSWORD) {
    redisOptions.password = process.env.REDIS_PASSWORD;
}

const redisClient = createClient(redisOptions);
let redisErrorLogged = false;

redisClient.on('ready', () => {
    redisErrorLogged = false;
});

redisClient.on('error', (err) => {
    if (redisClient.isReady) {
        console.error('Redis client error', err);
        return;
    }

    if (!redisErrorLogged) {
        console.warn('Redis unavailable; falling back to in-memory cache:', err?.message || err);
        redisErrorLogged = true;
    }
});

export default redisClient;
