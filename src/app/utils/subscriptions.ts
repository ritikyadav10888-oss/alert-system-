import Redis from 'ioredis';
import { isDev } from './db-config';

interface LocationSubscription {
    location: string;
    subscription: any;
    timestamp: string;
}

// Memory fallback for development
let memorySubscriptions: LocationSubscription[] = [];
const REDIS_SUBS_KEY = isDev ? 'push_subscriptions_test' : 'push_subscriptions';

// Singleton Redis Client matching db.ts logic
let redis: Redis | null = null;
const getRedisClient = () => {
    if (isDev) return null;
    if (!redis) {
        const url = process.env.REDIS_URL || process.env.KV_URL || '';
        if (url) {
            // Validation: ioredis needs redis:// or rediss://
            if (url.startsWith('https://')) return null;

            redis = new Redis(url, {
                tls: { rejectUnauthorized: false },
                maxRetriesPerRequest: 3,
                connectTimeout: 10000
            });
        }
    }
    return redis;
};

export const saveSubscription = async (location: string, subscription: any) => {
    const newSub: LocationSubscription = {
        location,
        subscription,
        timestamp: new Date().toISOString()
    };

    if (isDev) {
        memorySubscriptions = memorySubscriptions.filter(s =>
            JSON.stringify(s.subscription) !== JSON.stringify(subscription)
        );
        memorySubscriptions.push(newSub);
    } else {
        try {
            const client = getRedisClient();
            if (!client) return;
            const current = await getSubscriptions();
            const filtered = current.filter(s =>
                JSON.stringify(s.subscription) !== JSON.stringify(subscription)
            );
            filtered.push(newSub);
            await client.set(REDIS_SUBS_KEY, JSON.stringify(filtered));
        } catch (e) {
            console.error('Redis Subscription Save Error:', e);
        }
    }
};

export const getSubscriptions = async (): Promise<LocationSubscription[]> => {
    if (isDev) {
        return memorySubscriptions;
    } else {
        try {
            const client = getRedisClient();
            if (!client) return [];
            const data = await client.get(REDIS_SUBS_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error('Redis Subscription Fetch Error:', e);
            return [];
        }
    }
};
