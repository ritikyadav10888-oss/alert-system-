import webpush from 'web-push';
import { getSubscriptions } from './subscriptions';

const initWebPush = () => {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:if1905630373@gmail.com';

    if (!publicKey || !privateKey) {
        console.warn('Push Notification Keys missing. Skipping push initialization.');
        return false;
    }

    try {
        // Aggressive Cleaning: Trim, remove quotes, and strip padding
        const cleanPublicKey = publicKey.trim().replace(/^["']|["']$/g, '').replace(/=+$/, '');
        const cleanPrivateKey = privateKey.trim().replace(/^["']|["']$/g, '');

        const maskedPub = cleanPublicKey.substring(0, 10) + '...' + cleanPublicKey.substring(cleanPublicKey.length - 5);
        console.log(`[Push_V1] Standardizing VAPID Key: ${maskedPub}`);

        webpush.setVapidDetails(subject, cleanPublicKey, cleanPrivateKey);
        return true;
    } catch (e) {
        console.error('Error setting VAPID details:', e);
        return false;
    }
};

export const sendPushNotification = async (location: string, payload: { title: string, body: string, url?: string }) => {
    if (!initWebPush()) return;

    // getSubscriptions already handles checking Vercel KV or local memory
    const subscriptions = await getSubscriptions();

    // Filter by location (Targeted) or include all if location is generic (Broadcast)
    const targetSubs = subscriptions.filter(sub => {
        if (!location || location === 'Unknown' || location === 'General') return true;
        return sub.location === location;
    });

    console.log(`[Push] Sending to ${targetSubs.length} devices for location: ${location || 'Broadcast'}`);

    const promises = targetSubs.map(sub =>
        webpush.sendNotification(sub.subscription, JSON.stringify(payload))
            .catch(err => {
                console.error('Push error:', err);
                if (err.statusCode === 410 || err.statusCode === 404) {
                    console.log('Subscription expired/invalid');
                }
            })
    );

    await Promise.all(promises);
};
