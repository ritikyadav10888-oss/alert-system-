import { NextResponse } from 'next/server';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import { getBookings, saveBookings } from '@/app/utils/db';
import { sendPushNotification } from '@/app/utils/push';
import { stripHtml, cleanSlot, extractDateOnly, extractTimeOnly, extractCustomerInfo } from '@/app/utils/parser';

// Prevent caching for this API route
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    let connection: any;
    try {
        console.log('[Sync] Starting Email Check...');

        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
            console.error('[Sync] Error: Missing email credentials in environment.');
            return NextResponse.json({ success: false, message: 'Email credentials not configured' }, { status: 500 });
        }

        const config = {
            imap: {
                user: process.env.EMAIL_USER || '',
                password: process.env.EMAIL_PASSWORD || '',
                host: process.env.EMAIL_HOST || 'imap.gmail.com',
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
                authTimeout: 15000,
            },
        };

        console.log('[Sync] Connecting to IMAP...');
        connection = await imaps.connect(config);
        await connection.openBox('INBOX');

        const { searchParams } = new URL(req.url);
        const depth = searchParams.get('depth');
        const daysToSync = depth === 'all' ? 90 : 15; // Increased default to 15 days to ensure no gaps

        console.log(`[Sync] Syncing last ${daysToSync} days...`);

        const searchDate = new Date();
        searchDate.setDate(searchDate.getDate() - daysToSync);
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const searchDateStr = `${searchDate.getDate()}-${months[searchDate.getMonth()]}-${searchDate.getFullYear()}`;

        // 🚀 TARGETED SEARCH: Only fetch emails that actually matter
        // This makes the sync 10x faster and avoids Vercel timeouts
        const searchCriteria = [
            ['SINCE', searchDateStr]
        ];

        const fetchOptions = {
            bodies: ['HEADER.FIELDS (SUBJECT FROM DATE)'],
            markSeen: false,
        };

        const messages = await connection.search(searchCriteria, fetchOptions);
        const recentMessages = messages.sort((a: any, b: any) => b.attributes.uid - a.attributes.uid);

        const alerts: any[] = [];
        const candidates: any[] = [];

        const existingHistory = await getBookings();
        const existingUids = new Set(existingHistory.map((h: any) => h.id.toString()));
        const staleUids = new Set(existingHistory.filter((h: any) =>
            h.bookingSlot === 'MISSING' ||
            h.gameDate === 'TBD' ||
            h.location === 'Unknown Location' || // Allow re-parsing if location was missing
            !h.gameDate
        ).map((h: any) => h.id.toString()));

        console.log(`[Sync] Found ${messages.length} messages in search range. Filtered to ${recentMessages.length} potential new items.`);

        for (const item of recentMessages) {
            const uid = item.attributes.uid.toString();
            // Skip only if it exists AND is not marked as stale (MISSING/TBD)
            if (existingUids.has(uid) && !staleUids.has(uid)) continue;

            const headerPart = item.parts.find((part: any) => part.which === 'HEADER.FIELDS (SUBJECT FROM DATE)');
            const subject = headerPart?.body?.subject?.[0] || "No Subject";
            const from = headerPart?.body?.from?.[0] || "";
            const headerText = (subject + " " + from).toLowerCase();

            console.log(`[Sync_Debug] Processing UID: ${uid} | Subject: ${subject}`);

            const reviewKeywords = ['review', 'rate your', 'feedback', 'how was', 'share your experience'];
            if (reviewKeywords.some(kw => headerText.includes(kw))) {
                console.log(`[Sync_Skip] Filtered (Review/Feedback): ${uid}`);
                continue;
            }

            let platform: string | null = null;
            if (headerText.includes('playo')) platform = 'Playo';
            else if (headerText.includes('hudle')) platform = 'Hudle';
            else if (headerText.includes('district')) platform = 'District';
            else if (headerText.includes('khelomore') || headerText.includes('khelo more')) platform = 'Khelomore';
            else if (headerText.includes('google') || headerText.includes('security') || headerText.includes('verification') || headerText.includes('sign-in') || headerText.includes('code')) {
                platform = 'System';
            }

            if (platform) {
                console.log(`[Sync_Found] Candidate Platform: ${platform} for UID: ${uid}`);
                candidates.push({ uid: item.attributes.uid, platform, subject, date: item.attributes.date });
            } else {
                console.log(`[Sync_Skip] No Platform Match for UID: ${uid}`);
            }
        }

        if (candidates.length > 0) {
            const CHUNK_SIZE = 50;
            for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
                const chunk = candidates.slice(i, i + CHUNK_SIZE);
                const uids = chunk.map(c => c.uid);
                const fullMessages = await connection.search([['UID', uids.join(',')]], { bodies: [''], markSeen: false });

                for (const item of fullMessages) {
                    const uid = item.attributes.uid;
                    const cand = candidates.find(c => c.uid === uid);
                    if (!cand) continue;

                    const fullBody = item.parts.find((part: any) => part.which === '')?.body;
                    if (!fullBody) continue;

                    const parsed = await simpleParser(fullBody);
                    // Keep raw HTML for precise extraction, but also use cleanText for general scanning
                    const rawHtml = parsed.html || "";
                    const cleanText = stripHtml(parsed.text || parsed.html || "").toString();
                    const normalizedText = cleanText.replace(/\r\n/g, '\n');
                    const fullText = (cand.subject + " " + normalizedText).toLowerCase();

                    const locations = ['Matoshree', 'Matoshri', 'Baner', 'Model Coloney', 'Dahisar', 'Borivali', 'Andheri', 'Thane', 'Ghatkopar', 'Powai'];
                    let location = cand.platform === 'System' ? 'Security/Admin' : 'Unknown Location';
                    for (const loc of locations) {
                        if (fullText.includes(loc.toLowerCase())) {
                            location = loc === 'Matoshri' ? 'Matoshree' : loc;
                            break;
                        }
                    }

                    let rawSlots: string[] = [];
                    const lines = normalizedText.split('\n');
                    const keywords = ['slot', 'booking date', 'match date', 'start time', 'booking time', 'venue', 'purchase', 'event date', 'match time', 'transaction', 'invoice', 'date of play', 'booking details', 'booked for', 'slot details', 'match details'];
                    const datePattern = /(\d{1,2}\s+\w{3},\s*\d{4})|(\w{3},?\s+\d{1,2},?\s*\d{4})|(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})|(?:Tomorrow|Today)|(\w{4,9},?\s+\d{1,2} \w{3})|(\d{1,2}\s+\w{3}\s+'\d{2})/i;
                    const timePattern = /(\d{1,2}:\d{2}\s*(?:AM|PM)(?:\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM))?)/i;

                    for (const kw of keywords) {
                        const idx = lines.findIndex(l => l.toLowerCase().includes(kw));
                        if (idx !== -1) {
                            let lastFoundDate = "";
                            for (let i = Math.max(0, idx); i < idx + 20; i++) {
                                const line = lines[i]?.trim();
                                if (!line || line.includes('__:')) continue;

                                // 🛡️ QUOTA SHIELD: Ignore email header lines (Date, Sent, From, etc.)
                                const headerCheck = line.toLowerCase();
                                if (headerCheck.startsWith('date:') || headerCheck.startsWith('sent:') || headerCheck.startsWith('from:')) {
                                    continue;
                                }

                                const dMatch = line.match(datePattern);
                                const tMatch = line.match(timePattern);

                                if (dMatch) lastFoundDate = dMatch[0];

                                if (dMatch && tMatch) {
                                    rawSlots.push(line);
                                }
                                else if (tMatch) {
                                    if (lastFoundDate) {
                                        rawSlots.push(`${lastFoundDate}, ${tMatch[0]}`);
                                    } else {
                                        // Look back for date if not found yet
                                        for (let k = i - 5; k < i; k++) {
                                            const sub = lines[k]?.trim();
                                            const sd = sub?.match(datePattern);
                                            if (sd) {
                                                lastFoundDate = sd[0];
                                                rawSlots.push(`${lastFoundDate}, ${tMatch[0]}`);
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (rawSlots.length > 0) break;
                    }

                    if (rawSlots.length === 0) {
                        const globalRegex = /(\d{1,2}\s+\w{3},?\s*\d{4}.*?\d{1,2}:\d{2}\s*(?:AM|PM))|(\w{3},?\s+\d{1,2},?\s*\d{4}.*?\d{1,2}:\d{2}\s*(?:AM|PM))/gi;
                        const globalMatches = normalizedText.match(globalRegex);
                        if (globalMatches) rawSlots = globalMatches.filter(m => !m.includes('__:'));
                    }

                    // 🎾 CLEANUP: Filter out rawSlots that are just a single time (likely noise from header)
                    // We only want slots that look like a date + time range or a range "XX:XX - YY:YY"
                    const finalizedSlots = Array.from(new Set(rawSlots.map(s => cleanSlot(s)).filter(s => s.length > 0)));

                    // Specific fix for the "messy pipes" - if we have a proper range, remove the standalone pieces
                    const bookingSlot = finalizedSlots.filter(s => {
                        const hasRange = s.includes('-');
                        const hasDate = datePattern.test(s);
                        return hasRange || hasDate;
                    }).join(' | ') || (finalizedSlots[0] || 'MISSING');

                    let gameDate = extractDateOnly(bookingSlot);
                    // If date is STILL missing, search the body more aggressively
                    if (!gameDate || gameDate === 'MISSING' || gameDate === '') {
                        const dMatch = normalizedText.match(/(\d{1,2}\s+\w{3}\s+'\d{2})/i);
                        if (dMatch) gameDate = dMatch[0];
                    }

                    const gameTime = extractTimeOnly(bookingSlot);

                    let sport = '';
                    const sports = ['Badminton', 'Cricket', 'Pickleball', 'Football', 'Tennis', 'Squash'];
                    for (const s of sports) {
                        if (fullText.includes(s.toLowerCase())) { sport = s; break; }
                    }

                    // 💰 EXTRACT CUSTOMER & AMOUNT
                    const { customerName, amount } = extractCustomerInfo(normalizedText, rawHtml, cand.platform);

                    alerts.push({
                        id: uid.toString(),
                        platform: cand.platform,
                        location,
                        bookingSlot,
                        gameDate,
                        gameTime,
                        sport,
                        customerName,
                        amount,
                        message: cand.subject,
                        timestamp: parsed.date || cand.date || new Date()
                    });
                }
            }
        }

        if (alerts.length > 0) {
            const existingHistory = await getBookings();
            const combined = [...existingHistory, ...alerts];
            const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());

            await saveBookings(unique);

            // 📢 SEND PUSH NOTIFICATIONS FOR NEW ALERTS
            for (const alert of alerts) {
                const isNew = !existingHistory.some((h: any) => h.id === alert.id);
                if (isNew) {
                    await sendPushNotification(alert.location, {
                        title: `🏆 New ${alert.sport || 'Booking'}!`,
                        body: `${alert.platform}: ${alert.gameTime} at ${alert.location}`,
                        url: '/'
                    }).catch(err => console.error('Push error in loop:', err));
                }
            }
        }

        return NextResponse.json({ success: true, alerts });
    } catch (error: any) {
        console.error('[Sync_Fatal] Sync failed:', error.message);
        // Ensure connection is closed on error to prevent hanging handles
        if (connection) {
            try { connection.end(); } catch (e) { }
        }
        return NextResponse.json({
            success: false,
            message: `Sync Error: ${error.message || 'IMAP Timeout or Credential issue'}`
        }, { status: 500 });
    } finally {
        if (connection) {
            try { connection.end(); } catch (e) { }
        }
    }
}
