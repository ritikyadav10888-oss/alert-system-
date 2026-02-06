
/**
 * Aggressively strips HTML tags from a string and normalizes whitespace
 */
export function stripHtml(html: string): string {
    return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Cleans up booking slot strings - rejects junk and trims
 */
export function cleanSlot(slot: string): string {
    if (!slot) return "";
    let cleaned = slot.replace(/__:?|MISSING/g, "").trim();
    // Remove trailing commas/dashes
    cleaned = cleaned.replace(/^[,\s-]+|[,\s-]+$/g, "");
    return cleaned;
}

/**
 * Extracts a date string from a messy slot string
 */
export function extractDateOnly(slot: string): string {
    // Look for formats: 2026-02-06, Feb 4, 31-01-2026, 06 Feb '26 etc.
    const dateMatch = slot.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}-\d{1,2}-\d{4})|(\d{1,2}\s+\w{3},\s*\d{4})|(\w{3},?\s+\d{1,2},?\s*\d{4})|(\d{1,2}\s+\w{3}\s+'\d{2})/i);
    return dateMatch ? dateMatch[0] : "";
}

/**
 * MERGES back-to-back time slots into a single duration (e.g., 7:30-8:30)
 */
export function extractTimeOnly(slot: string): string {
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
export function extractCustomerInfo(text: string, html: string, platform: string) {
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
