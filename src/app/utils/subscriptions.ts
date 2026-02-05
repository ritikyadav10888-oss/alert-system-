import { kv } from '@vercel/kv';
import { isDev } from './db-config';

interface LocationSubscription {
    location: string;
    subscription: any;
    timestamp: string;
}

// Memory fallback for development
let memorySubscriptions: LocationSubscription[] = [];
const KV_SUBS_KEY = isDev ? 'push_subscriptions_test' : 'push_subscriptions';

export const saveSubscription = async (location: string, subscription: any) => {
    const newSub: LocationSubscription = {
        location,
        subscription,
        timestamp: new Date().toISOString()
    };

    if (isDev) {
        // Remove existing for this subscription if exists
        memorySubscriptions = memorySubscriptions.filter(s =>
            JSON.stringify(s.subscription) !== JSON.stringify(subscription)
        );
        memorySubscriptions.push(newSub);
    } else {
        // Production: Save to Vercel KV
        try {
            const current = await getSubscriptions();
            const filtered = current.filter(s =>
                JSON.stringify(s.subscription) !== JSON.stringify(subscription)
            );
            filtered.push(newSub);
            await kv.set(KV_SUBS_KEY, filtered);
        } catch (e) {
            console.error('KV Subscription Save Error:', e);
        }
    }
};

export const getSubscriptions = async (): Promise<LocationSubscription[]> => {
    if (isDev) {
        return memorySubscriptions;
    } else {
        try {
            const data = await kv.get<LocationSubscription[]>(KV_SUBS_KEY);
            return data || [];
        } catch (e) {
            console.error('KV Subscription Fetch Error:', e);
            return [];
        }
    }
};
