"use client";

import { useState, useEffect, useRef } from 'react';
import AlertPopup, { AlertProps } from './components/AlertPopup';
import { playAlertSound } from './utils/sound';
import { getManagerForLocation } from './utils/managers';
import styles from './page.module.css';

interface AlertItem extends AlertProps {
    id: string;
    platform: 'Playo' | 'Hudle' | 'District' | 'Khelomore' | 'System';
    bookingSlot?: string;
    gameDate?: string;
    gameTime?: string;
    sport?: string;
    customerName?: string;
    amount?: string;
    managerName?: string;
}

export default function Home() {
    const [alerts, setAlerts] = useState<AlertItem[]>([]);
    const [selectedLocation, setSelectedLocation] = useState('Bangalore Arena');
    const [bookingHistory, setBookingHistory] = useState<AlertItem[]>([]);
    const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
    const [isTest, setIsTest] = useState(false);

    useEffect(() => {
        setIsTest(process.env.NODE_ENV === 'development');
    }, []);

    // 1. Request notification permission on mount
    // 2. Load History from Database
    useEffect(() => {
        if ("Notification" in window && Notification.permission === "default") {
            Notification.requestPermission();
        }

        const loadHistory = async () => {
            try {
                const res = await fetch('/api/get-history');
                const data = await res.json();
                if (data.success && data.history) {
                    // Convert timestamp strings back to Date objects
                    const formatted = data.history.map((item: any) => ({
                        ...item,
                        timestamp: new Date(item.timestamp)
                    }));
                    setBookingHistory(formatted);
                }
            } catch (e) {
                console.error("Failed to load history", e);
            } finally {
                setIsHistoryLoaded(true);
            }
        };

        loadHistory();
    }, []);

    const sendNativeNotification = (title: string, body: string) => {
        if ("Notification" in window && Notification.permission === "granted") {
            new Notification(title, { body, icon: '/manifest.json' });
        }
    };

    const locations = [
        'Thane',
        'Baner',
        'Model Coloney',
        'Dahisar',
        'Borivali',
        'Andheri',
        'Matoshree'
    ];

    const triggerAlert = (platform: AlertProps['platform']) => {
        const newAlert: AlertItem = {
            id: Date.now().toString(),
            platform,
            // User request: "also maintion platfrom and location"
            message: `New booking confirmed on ${platform} for ${selectedLocation}.`,
            location: selectedLocation,
            timestamp: new Date(),
            onDismiss: removeAlert
        };

        setAlerts(prev => [newAlert, ...prev]); // Add new alert to top
        setBookingHistory(prev => [newAlert, ...prev]); // Add to history
        playAlertSound();
    };

    const removeAlert = (id: string) => {
        setAlerts(prev => prev.filter(a => a.id !== id));
    };

    const [isLiveSync, setIsLiveSync] = useState(true);
    const [syncStatus, setSyncStatus] = useState('Initializing...');
    const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
    const [isPushSubmitting, setIsPushSubmitting] = useState(false);
    const [pushStatus, setPushStatus] = useState<'default' | 'enabled' | 'error'>('default');

    // Helper for VAPID conversion
    const urlBase64ToUint8Array = (base64String: string) => {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    };

    const subscribeToPush = async () => {
        setIsPushSubmitting(true);
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!)
            });

            const res = await fetch('/api/push-subscription', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subscription,
                    location: selectedLocation
                })
            });

            if (res.ok) {
                setPushStatus('enabled');
                alert(`🔔 Success! You will now receive alerts for ${selectedLocation} directly on your phone.`);
            } else {
                throw new Error('Server failed to save subscription');
            }
        } catch (e) {
            console.error('Push subscription failed', e);
            setPushStatus('error');
            alert('❌ Failed to enable push notifications. Make sure you are on HTTPS or localhost and have allowed permissions.');
        } finally {
            setIsPushSubmitting(false);
        }
    };

    // 📅 Help format messy date strings for the UI
    const formatGameDate = (dateStr: string) => {
        if (!dateStr || dateStr === 'TBD' || dateStr === '-' || dateStr === 'MISSING') return "TBD";
        try {
            // Special handling for Khelomore '26 format
            const cleanStr = dateStr.replace(/'(\d{2})/, '20$1');
            const date = new Date(cleanStr);
            if (!isNaN(date.getTime())) {
                return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            }
        } catch (e) { }
        return dateStr;
    };

    // Sort History Logic (Newest at top)
    const sortedHistory = [...bookingHistory].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());


    // Use a ref for locking to prevent overlapping interval calls
    const isSyncingRef = useRef(false);

    // Check Emails from Real Backend with Retry Logic
    const checkEmails = async (retries = 1, depth = '') => {
        if (!isLiveSync || isSyncingRef.current || !isHistoryLoaded) return;

        isSyncingRef.current = true;
        setSyncStatus(depth === 'all' ? 'Deep Scanning All Mails...' : 'Sync In Progress...');

        try {
            const res = await fetch(`/api/check-emails${depth === 'all' ? '?depth=all' : ''}`);
            const data = await res.json();

            if (data.success) {
                if (data.alerts && data.alerts.length > 0) {
                    setSyncStatus(`Updated ${data.alerts.length} items`);

                    // 🛡️ DATA HEALING: Merge new data into existing history state
                    // This ensures that if the backend fixes a MISSING slot, it updates in real-time
                    setBookingHistory(prev => {
                        const newHistory = [...prev];
                        data.alerts.forEach((a: any) => {
                            const idx = newHistory.findIndex(h => h.id === a.id);
                            const formatted = { ...a, timestamp: new Date(a.timestamp) };
                            if (idx > -1) {
                                newHistory[idx] = formatted;
                            } else {
                                newHistory.push(formatted);
                            }
                        });
                        return newHistory;
                    });

                    data.alerts.forEach((a: any) => {
                        const alertDate = new Date(a.timestamp);
                        const isLive = (Date.now() - alertDate.getTime()) < 60 * 60 * 1000 && depth !== 'all';

                        triggerAutoAlert(
                            a.platform,
                            a.location,
                            a.message,
                            a.bookingSlot,
                            a.sport,
                            isLive,
                            alertDate,
                            a.id,
                            a.gameDate,
                            a.gameTime
                        );
                    });
                } else {
                    setSyncStatus(depth === 'all' ? 'Deep Sync Complete' : 'Sync Active (Waiting)');
                }
                setLastSyncTime(new Date());
            } else {
                setSyncStatus('Sync Error: ' + (data.message || 'Check connection'));
            }
        } catch (error) {
            console.error("Sync fetch error:", error);
            if (retries > 0) {
                setSyncStatus('Connection lost. Retrying in 5s...');
                setTimeout(() => { isSyncingRef.current = false; checkEmails(retries - 1, depth); }, 5000);
                return;
            }
            setSyncStatus('Connection Failed');
        } finally {
            isSyncingRef.current = false;
        }
    };

    const handleDeepSync = () => {
        if (!confirm("This will scan your entire inbox for the last 3 months to upload all old emails. Proceed?")) return;
        checkEmails(1, 'all');
    };

    useEffect(() => {
        if (isHistoryLoaded) {
            checkEmails();
        }
        // 60s to stay within Vercel KV Free Tier (3000 req/day)
        const interval = setInterval(checkEmails, 60000);
        return () => clearInterval(interval);
    }, [isLiveSync, isHistoryLoaded]);

    const handleClearHistory = async () => {
        if (!confirm("Are you sure you want to clear your local booking history? This cannot be undone.")) return;

        try {
            const res = await fetch('/api/clear-history', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setBookingHistory([]);
                alert("History cleared successfully.");
            }
        } catch (e) {
            console.error(e);
            alert("Failed to clear history.");
        }
    };

    // Use a ref to track IDs that have already triggered a popup/notification in this session
    const notifiedSessionIds = useRef<Set<string>>(new Set());

    const triggerAutoAlert = (
        platform: AlertProps['platform'],
        location: string,
        msg: string,
        slot: string | undefined,
        sport: string | undefined,
        shouldPlaySound = true,
        timestamp?: Date,
        alertId: string = Math.random().toString(),
        gameDate: string = "",
        gameTime: string = ""
    ) => {
        // 1. Session Duplicate Check: If we already popped this in the current session, skip.
        if (notifiedSessionIds.current.has(alertId)) return;

        // 2. History Duplicate Check: If it's already in the table, skip.
        if (bookingHistory.some(item => item.id === alertId)) return;

        const manager = getManagerForLocation(location);
        const isSystemBroadcast = location === 'Unknown Location' || location === 'System' || location === 'Security/Admin' || !location;

        const newAlert: AlertItem = {
            id: alertId,
            platform,
            message: msg,
            location: isSystemBroadcast ? 'System Update' : location,
            timestamp: timestamp || new Date(),
            onDismiss: removeAlert,
            bookingSlot: slot || (shouldPlaySound ? "Just Now" : "MISSING"),
            gameDate: gameDate || "",
            gameTime: gameTime || "",
            sport: sport || "General",
            managerName: isSystemBroadcast ? 'ALL MANAGERS' : manager.name
        };

        // Mark as notified so we don't repeat
        notifiedSessionIds.current.add(alertId);

        // ONLY Pop up, Sound, and Notify if it's a Live Alert
        if (shouldPlaySound) {
            setAlerts(prev => [newAlert, ...prev]);

            // Triple Alert Sound Logic (3 pulses, 1s apart)
            let pulses = 0;
            playAlertSound(); // Play immediately first
            pulses++;

            const pulseInterval = setInterval(() => {
                if (pulses < 3) {
                    playAlertSound();
                    pulses++;
                } else {
                    clearInterval(pulseInterval);
                }
            }, 1000);

            // 📢 NATIVE NOTIFICATION
            const notificationTitle = isSystemBroadcast
                ? `📢 SYSTEM: ${platform} Update`
                : `Attention ${manager.name}: New ${platform} Booking!`;

            const notificationBody = isSystemBroadcast
                ? `Update: ${msg}`
                : `${sport || 'Booking'} at ${location}. Time: ${slot || 'Just Now'}`;

            sendNativeNotification(notificationTitle, notificationBody);
        }

        setBookingHistory(prev => {
            if (prev.some(item => item.id === alertId)) return prev;
            return [newAlert, ...prev];
        });
    };

    const getPlatformColor = (platform: string) => {
        switch (platform) {
            case 'Playo': return { bg: '#dcfce7', text: '#15803d' };
            case 'Hudle': return { bg: '#e0f2fe', text: '#0369a1' };
            case 'Khelomore': return { bg: '#fee2e2', text: '#b91c1c' };
            case 'System': return { bg: '#f3e8ff', text: '#7e22ce' };
            default: return { bg: '#f1f5f9', text: '#475569' };
        }
    };

    return (
        <main className={styles.main}>
            <div className={styles.dashboard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                    <h1 className={styles.title}>Turf Alert Dashboard</h1>
                    <span style={{
                        padding: '6px 16px',
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: '800',
                        background: isTest ? '#fef3c7' : '#dcfce7',
                        color: isTest ? '#92400e' : '#166534',
                        border: `1px solid ${isTest ? '#f59e0b' : '#22c55e'}`,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                    }}>
                        {isTest ? '🧪 Test Mode' : '🚀 Production'}
                    </span>
                </div>

                <div className={styles.statsHeader}>
                    {/* Stats Card: Total Bookings */}
                    <div className={styles.statsCard}>
                        <div style={{ fontSize: '2rem' }}>📜</div>
                        <div>
                            <div style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 600 }}>TOTAL BOOKINGS</div>
                            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#1e293b' }}>{sortedHistory.length}</div>
                        </div>
                    </div>

                    {/* Stats Card: Sync Status */}
                    {isLiveSync && (
                        <div className={styles.statsCard} style={{ minWidth: '250px' }}>
                            <div className={styles.syncPulse}></div>
                            <div>
                                <div style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 600 }}>SYNC STATUS</div>
                                <div style={{ fontWeight: 600, color: '#0f172a' }}>{syncStatus}</div>
                                {lastSyncTime && (
                                    <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                                        Last: {lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                            onClick={handleDeepSync}
                            style={{
                                background: 'white',
                                color: '#475569',
                                border: '1px solid #cbd5e1',
                                padding: '10px 16px',
                                borderRadius: '10px',
                                cursor: 'pointer',
                                fontWeight: '600',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
                            }}
                        >
                            🚀 Sync All
                        </button>
                        <button
                            onClick={handleClearHistory}
                            style={{
                                background: '#fee2e2',
                                color: '#b91c1c',
                                border: '1px solid #fecaca',
                                padding: '10px 16px',
                                borderRadius: '10px',
                                cursor: 'pointer',
                                fontWeight: '600',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
                            }}
                        >
                            🗑️ Clear
                        </button>
                    </div>
                </div>

                {/* Mobile View: Card List */}
                <div className={styles.mobileCardContainer}>
                    {!isHistoryLoaded ? (
                        [1, 2, 3].map(i => (
                            <div key={`skel-mob-${i}`} className={styles.mobileCard}>
                                <div className={styles.skeletonLine} style={{ width: '60%' }}></div>
                                <div className={styles.skeletonLine} style={{ width: '80%' }}></div>
                                <div className={styles.skeletonLine} style={{ width: '40%' }}></div>
                            </div>
                        ))
                    ) : sortedHistory.map((item) => {
                        const pStyle = getPlatformColor(item.platform);
                        return (
                            <div key={item.id} className={styles.mobileCard}>
                                <div className={styles.cardHeader}>
                                    <span className={styles.platformBadge} style={{ background: pStyle.bg, color: pStyle.text }}>
                                        {item.platform}
                                    </span>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>{formatGameDate(item.gameDate || "")}</div>
                                        <div style={{ fontSize: '0.8rem', color: '#64748b' }}>{item.gameTime || item.bookingSlot}</div>
                                    </div>
                                </div>
                                <div className={styles.cardBody}>
                                    <div className={styles.cardRow}>
                                        <span className={styles.customer} style={{ fontSize: '1.1rem' }}>{item.customerName || 'Unknown User'}</span>
                                        <span className={styles.amount} style={{ fontSize: '1.1rem' }}>{item.amount ? `₹${item.amount}` : '-'}</span>
                                    </div>
                                    <div className={styles.cardRow}>
                                        <div className={styles.location}>
                                            <span>📍</span> {item.location}
                                        </div>
                                        <span className={styles.sportBadge}>{item.sport || 'General'}</span>
                                    </div>
                                </div>
                                <div className={styles.cardFooter}>
                                    <span className={styles.notifiedBadge}>👤 {getManagerForLocation(item.location).name}</span>
                                    <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                                        {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Desktop View: Table */}
                <div className={styles.tableContainer}>
                    <table className={styles.bookingTable}>
                        <thead>
                            <tr>
                                <th>Platform</th>
                                <th>Game Date</th>
                                <th>Game Time</th>
                                <th>Sport</th>
                                <th>Location</th>
                                <th>Customer</th>
                                <th>Amount</th>
                                <th>Notified</th>
                                <th>Received</th>
                            </tr>
                        </thead>
                        <tbody>
                            {!isHistoryLoaded ? (
                                [1, 2, 3, 4, 5].map(i => (
                                    <tr key={`skeleton-${i}`}>
                                        <td colSpan={9}><div className={styles.skeletonLine}></div></td>
                                    </tr>
                                ))
                            ) : sortedHistory.length === 0 ? (
                                <tr>
                                    <td colSpan={9} style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>
                                        📭 No bookings found.
                                    </td>
                                </tr>
                            ) : (
                                sortedHistory.map((item: any) => {
                                    const pStyle = getPlatformColor(item.platform);
                                    return (
                                        <tr key={item.id}>
                                            <td>
                                                <span className={styles.platformBadge} style={{ background: pStyle.bg, color: pStyle.text }}>
                                                    {item.platform}
                                                </span>
                                            </td>
                                            <td style={{ fontWeight: 700, color: '#0f172a' }}>{formatGameDate(item.gameDate)}</td>
                                            <td style={{ fontWeight: 600, color: '#334155' }}>{item.gameTime || item.bookingSlot || '-'}</td>
                                            <td><span className={styles.sportBadge}>{item.sport || 'General'}</span></td>
                                            <td><div className={styles.location}>{item.location}</div></td>
                                            <td className={styles.customer}>{item.customerName || '-'}</td>
                                            <td className={styles.amount}>{item.amount ? `₹${item.amount}` : '-'}</td>
                                            <td><span className={styles.notifiedBadge}>{getManagerForLocation(item.location).name}</span></td>
                                            <td style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                                                {item.timestamp.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}<br />
                                                {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                <div style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.8rem', color: '#94a3b8' }}>
                    <p>Simulating user on Mobile (Turf Manager) • Sound Active</p>
                </div>
            </div>

            <div className={styles.alertContainer}>
                {alerts.map((alert, index) => (
                    <div key={alert.id} style={{ marginTop: index * 10 }}>
                        <AlertPopup {...alert} />
                    </div>
                ))}
            </div>
        </main >
    );
}
