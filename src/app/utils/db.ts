import { kv } from '@vercel/kv';
import fs from 'fs';
import path from 'path';
import { isDev } from './db-config';

const DB_FILE = isDev ? 'bookings_test.json' : 'bookings.json';
const DB_PATH = path.join(process.cwd(), 'data', DB_FILE);
const KV_KEY = isDev ? 'bookings_test' : 'bookings';

export const getBookings = async (): Promise<any[]> => {
    if (isDev) {
        if (!fs.existsSync(DB_PATH)) return [];
        try {
            return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        } catch (e) {
            return [];
        }
    } else {
        // Production: Use Vercel KV
        try {
            const kvUrl = process.env.KV_REST_API_URL || 'MISSING';
            const maskedUrl = kvUrl.substring(0, 8) + '...' + kvUrl.substring(kvUrl.length - 4);
            console.log(`[KV_PROD_V1] Connecting to KV: ${maskedUrl}`);

            const data = await kv.get<any[]>(KV_KEY);
            if (data) console.log(`[KV_PROD_V1] Fetched ${data.length} records from KV`);
            return data || [];
        } catch (e) {
            console.error("[KV_PROD_V1] Fetch Error:", e);
            return [];
        }
    }
};

export const saveBookings = async (bookings: any[]): Promise<void> => {
    // Safety: Only keep the latest 1000 items
    const cappedBookings = bookings.slice(0, 1000);

    if (isDev) {
        if (!fs.existsSync(path.dirname(DB_PATH))) {
            fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        }
        fs.writeFileSync(DB_PATH, JSON.stringify(cappedBookings, null, 2));
    } else {
        // Production: Use Vercel KV
        try {
            await kv.set(KV_KEY, cappedBookings);
        } catch (e) {
            console.error("KV Save Error:", e);
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
            await kv.set(KV_KEY, []);
        } catch (e) {
            console.error("KV Clear Error:", e);
        }
    }
};
