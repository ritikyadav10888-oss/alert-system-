import { NextResponse } from 'next/server';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import { getBookings, saveBookings } from '@/app/utils/db';
import { sendPushNotification } from '@/app/utils/push';

// Prevent caching for this API route
export const dynamic = 'force-dynamic';

/**
 * Aggressively strips HTML tags from a string and normalizes whitespace
 */
function stripHtml(html: string): string {
    return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Cleans up booking slot strings - rejects junk and trims
 */
function cleanSlot(slot: string): string {
    if (!slot) return "";
    let cleaned = slot.replace(/__:?|MISSING/g, "").trim();
    // Remove trailing commas/dashes
    cleaned = cleaned.replace(/^[,\s-]+|[,\s-]+$/g, "");
    return cleaned;
}

/**
 * Extracts a date string from a messy slot string
 */
function extractDateOnly(slot: string): string {
    // Look for formats: 2026-02-06, Feb 4, 31-01-2026, 06 Feb '26 etc.
    const dateMatch = slot.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}-\d{1,2}-\d{4})|(\d{1,2}\s+\w{3},\s*\d{4})|(\w{3},?\s+\d{1,2},?\s*\d{4})|(\d{1,2}\s+\w{3}\s+'\d{2})/i);
    return dateMatch ? dateMatch[0] : "";
}

/**
 * MERGES back-to-back time slots into a single duration (e.g., 7:30-8:30)
 */
function extractTimeOnly(slot: string): string {
    const timeMatches = slot.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)(?:\s*-\s*\d{1,2}:\d{2}\s*(?:AM|PM))?)/gi);
    if (!timeMatches) return "";

    // Normalize to range objects
    const ranges = Array.from(new Set(timeMatches)).map(t => {
        const parts = t.split('-').map(p => p.trim());
        const start = parts[0];
        const end = parts[1] || parts[0];
        const startT = new Date(`2000/01/01 ${start}`).getTime();
        const endT = new Date(`2000/01/01 ${end}`).getTime();
        return { start, end, startT, endT };
    });

    // Sort by start transition
    ranges.sort((a, b) => a.startT - b.startT);

    // Merge logic
    const merged: { start: string, end: string, endT: number }[] = [];
    for (const r of ranges) {
        if (merged.length === 0) {
            merged.push(r);
            continue;
        }
        const last = merged[merged.length - 1];
        // If this slot starts when the last one ends -> Merge!
        if (r.startT === last.endT) {
            last.end = r.end;
            last.endT = r.endT;
        } else if (r.startT < last.endT) {
            // Overlapping
            if (r.endT > last.endT) {
                last.end = r.end;
                last.endT = r.endT;
            }
        } else {
            merged.push(r);
        }
    }

    return merged.map(m => m.start === m.end ? m.start : `${m.start} - ${m.end}`).join(' | ');
}

/**
 * Extracts customer info (Name, Amount) based on platform logic
 */
function extractCustomerInfo(text: string, html: string, platform: string) {
    let customerName = "";
    let amount = "";

    const cleanAmount = (amt: string) => {
        // Removes symbols, keeps numbers and decimals
        const match = amt.match(/[\d,]+(\.\d+)?/);
        return match ? match[0] : "";
    };

    if (platform === 'Khelomore') {
        // Name Logic
        const nameMatch1 = html.match(/Booked by\s+([A-Za-z\s]+)/i);
        const nameMatch2 = html.match(/Name:\s*<\/span>\s*([^<]+)/i);
        if (nameMatch2) customerName = nameMatch2[1].trim();
        else if (nameMatch1) customerName = nameMatch1[1].trim();

        // Amount Logic
        const amountMatch = html.match(/(&#8377;|₹)\s*([\d,]+)/);
        if (amountMatch) amount = cleanAmount(amountMatch[2]);
    }
    else if (platform === 'Hudle') {
        // Name Logic
        const nameMatch = html.match(/Name\s*<\/strong>\s*:\s*([^<]+)/i);
        if (nameMatch) customerName = nameMatch[1].trim();

        // Amount Logic
        const amountMatch = html.match(/Amount Paid\s*<\/strong>\s*:\s*(?:&#8377;|₹|=E2=82=B9)\s*([\d,]+(\.\d{2})?)/i);
        if (amountMatch) {
            amount = cleanAmount(amountMatch[1]);
        } else {
             // Fallback for quoted-printable encoding =E2=82=B9
             const qpMatch = html.match(/Amount Paid\s*<\/strong>\s*:\s*.*?\s*([\d,]+(\.\d{2})?)/i);
             if (qpMatch) amount = cleanAmount(qpMatch[1]);
        }
    }
    else if (platform === 'Playo') {
        // Name Logic: "Hey Amit,"
        const nameMatch = html.match(/Hey\s+([^,]+),/i);
        if (nameMatch) customerName = nameMatch[1].trim();

        // Amount Logic
        // 1. Look for "Total Amount Paid" followed by "INR X" (allowing for newlines/spaces)
        // Note: Using [\s\S]*? instead of s flag for broader compatibility
        const amountMatch = html.match(/Total Amount Paid[\s\S]*?INR\s*([\d,]+(\.\d+)?)/i);
        if (amountMatch) {
             amount = cleanAmount(amountMatch[1]);
        } else {
            // Fallback: Advance Paid
             const advMatch = html.match(/Advance Paid[\s\S]*?INR\s*([\d,]+(\.\d+)?)/i);
             if (advMatch) amount = cleanAmount(advMatch[1]);
        }
    }
    else {
        // Generic Fallback
        const nameMatch = text.match(/(?:Name|Customer|Booked By)\s*[:|-]\s*([A-Za-z\s]+)/i);
        if (nameMatch && nameMatch[1].length < 30) customerName = nameMatch[1].trim();

        const amountMatch = text.match(/(?:Amount|Paid|Total)\s*[:|-]\s*(?:₹|INR|Rs\.?)\s*([\d,]+)/i);
        if (amountMatch) amount = cleanAmount(amountMatch[1]);
    }

    return { customerName, amount };
}


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
