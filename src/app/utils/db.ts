import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import { isDev } from './db-config';

const DB_FILE = isDev ? 'bookings_test.json' : 'bookings.json';
const DB_PATH = path.join(process.cwd(), 'data', DB_FILE);
const REDIS_KEY = isDev ? 'bookings_test' : 'bookings';

// --- QUOTA SHIELD: Server-side In-Memory Cache ---
let memoryCache: any[] | null = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 30000; // 30 seconds

// Singleton Redis Client
let redis: Redis | null = null;
const getRedisClient = () => {
    if (isDev) return null;
    if (!redis) {
        const url = process.env.REDIS_URL || process.env.KV_URL || '';
        if (url) {
            console.log(`[REDIS_READY] Initializing ioredis client (Masked: ${url.substring(0, 10)}...)`);
            redis = new Redis(url, {
                tls: { rejectUnauthorized: false },
                maxRetriesPerRequest: 3
            });
        }
    }
    return redis;
};

export const getBookings = async (): Promise<any[]> => {
    if (isDev) {
        if (!fs.existsSync(DB_PATH)) return [];
        try {
            return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        } catch (e) { return []; }
    } else {
        // Production: ioredis with Quota Shield
        try {
            // 📊 Quota Shield: Return cache if fresh
            if (memoryCache && (Date.now() - lastCacheUpdate < CACHE_TTL)) {
                return memoryCache;
            }

            const client = getRedisClient();
            if (!client) return [];

            const data = await client.get(REDIS_KEY);
            const parsed = data ? JSON.parse(data) : [];

            // Update cache
            memoryCache = parsed;
            lastCacheUpdate = Date.now();

            console.log(`[KV_PROD_V2] Fetched ${parsed.length} records from Redis`);
            return parsed;
        } catch (e) {
            console.error("[KV_PROD_V2] Redis Fetch Error:", e);
            return memoryCache || []; // Return stale if error
        }
    }
};

export const saveBookings = async (bookings: any[]): Promise<void> => {
    const cappedBookings = bookings.slice(0, 1000);

    if (isDev) {
        if (!fs.existsSync(path.dirname(DB_PATH))) {
            fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        }
        fs.writeFileSync(DB_PATH, JSON.stringify(cappedBookings, null, 2));
    } else {
        // Production: ioredis with Quota Shield
        try {
            const client = getRedisClient();
            if (!client) return;

            // 🛡️ Quota Shield: Change Detection
            const existing = await getBookings();
            const lastExistingId = existing[0]?.id;
            const lastNewId = cappedBookings[0]?.id;

            if (existing.length === cappedBookings.length && lastExistingId === lastNewId) {
                console.log("[QUOTA_SHIELD] No new data. Skipping Redis write.");
                return;
            }

            await client.set(REDIS_KEY, JSON.stringify(cappedBookings));
            // Invalidate cache immediately on write
            memoryCache = cappedBookings;
            lastCacheUpdate = Date.now();
            console.log("[QUOTA_SHIELD] Redis updated with new data.");
        } catch (e) {
            console.error("Redis Save Error:", e);
        }
    }
};

export const clearHistory = async (): Promise<void> => {
    if (isDev) {
        if (fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
        }
    } else {
        try {
            const client = getRedisClient();
            if (client) {
                await client.set(REDIS_KEY, JSON.stringify([]));
                memoryCache = [];
            }
        } catch (e) {
            console.error("Redis Clear Error:", e);
        }
    }
};
