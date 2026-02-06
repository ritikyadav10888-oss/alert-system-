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
    managerName?: string;
    bookingName?: string;
    paidAmount?: string;
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
                            a.gameTime,
                            a.bookingName || "N/A",
                            a.paidAmount || "N/A"
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
        gameTime: string = "",
        bookingName: string = "N/A",
        paidAmount: string = "N/A"
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
            managerName: isSystemBroadcast ? 'ALL MANAGERS' : manager.name,
            bookingName: bookingName,
            paidAmount: paidAmount
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

    return (
        <main className={styles.main}>
            <div className={styles.dashboard}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '15px', marginBottom: '2rem' }}>
                    <h1 className={styles.title} style={{ margin: 0 }}>Turf Alert Dashboard</h1>
                    <span style={{
                        padding: '4px 12px',
                        borderRadius: '20px',
                        fontSize: '0.75rem',
                        fontWeight: 'bold',
                        background: isTest ? '#fef3c7' : '#dcfce7',
                        color: isTest ? '#92400e' : '#166534',
                        border: `1px solid ${isTest ? '#f59e0b' : '#22c55e'}`,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px'
                    }}>
                        {isTest ? '🧪 Test Mode' : '🚀 Production'}
                    </span>
                </div>

                <div className={styles.divider}>
                    <div className={styles.historyHeader} style={{ display: 'flex', alignItems: 'center', gap: '15px', width: '100%', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 800, fontSize: '1.1rem' }}>📜 Booking History</span>

                        {isLiveSync && (
                            <div className={styles.syncStatus} style={{ padding: '10px 15px', background: '#e3f2fd', borderRadius: '12px', border: '1px solid #bbdefb', fontSize: '0.85rem', textAlign: 'center', color: '#0d47a1', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                                <span className={styles.syncPulse}></span>
                                <div style={{ textAlign: 'left' }}>
                                    <strong>Status:</strong> {syncStatus}
                                    {lastSyncTime && (
                                        <div style={{ fontSize: '0.65rem', opacity: 0.8 }}>
                                            Last Check: {lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        <div className={styles.historyControls} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '0.75rem', background: '#f1f5f9', padding: '4px 10px', borderRadius: '20px', color: '#64748b', fontWeight: 'bold' }}>
                                Records: {sortedHistory.length}
                            </span>
                            <button
                                onClick={handleDeepSync}
                                style={{
                                    fontSize: '0.7rem',
                                    background: '#334155',
                                    color: 'white',
                                    border: 'none',
                                    padding: '6px 12px',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    fontWeight: '600'
                                }}
                                title="Sync all historical data from last 4 months"
                            >
                                🚀 Sync All
                            </button>
                            <button
                                onClick={handleClearHistory}
                                style={{
                                    fontSize: '0.7rem',
                                    background: '#fee2e2',
                                    color: '#b91c1c',
                                    border: '1px solid #fecaca',
                                    padding: '6px 12px',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    fontWeight: '600'
                                }}
                                title="Clear history"
                            >
                                🗑️ Clear
                            </button>
                        </div>
                    </div>
                </div>


                <div className={styles.tableContainer}>
                    <table className={styles.bookingTable}>
                        <thead style={{ background: '#f1f5f9', position: 'sticky', top: 0, zIndex: 10, borderBottom: '2px solid #e2e8f0' }}>
                            <tr>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '100px', color: '#475569', fontWeight: '700' }}>📧 Received</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '100px', color: '#475569', fontWeight: '700' }}>📅 Game Date</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '130px', color: '#475569', fontWeight: '700' }}>⏰ Game Time</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '90px', color: '#475569', fontWeight: '700' }}>Platform</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '90px', color: '#475569', fontWeight: '700' }}>Sport</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '120px', color: '#475569', fontWeight: '700' }}>👤 Customer</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '100px', color: '#475569', fontWeight: '700' }}>💰 Amount</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '120px', color: '#475569', fontWeight: '700' }}>📍 Location</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', minWidth: '130px', color: '#475569', fontWeight: '700' }}>👤 Notified</th>
                                <th style={{ padding: '15px 10px', textAlign: 'left', color: '#475569', fontWeight: '700' }}>Details</th>
                            </tr>
                        </thead>
                        <tbody>
                            {!isHistoryLoaded ? (
                                // ⚡ LOADING SKELETON ROWS ⚡
                                [1, 2, 3, 4, 5].map(i => (
                                    <tr key={`skeleton-${i}`} className={styles.skeletonRow}>
                                        <td colSpan={10} style={{ padding: '15px 10px' }}>
                                            <div className={styles.skeletonLine}></div>
                                        </td>
                                    </tr>
                                ))
                            ) : sortedHistory.length === 0 ? (
                                <tr>
                                    <td colSpan={10} style={{ padding: '30px', textAlign: 'center', color: '#888' }}>
                                        📭 No bookings yet.
                                    </td>
                                </tr>
                            ) : (
                                sortedHistory.map((item: any) => (
                                    <tr key={item.id} style={{ borderBottom: '1px solid #f0f0f0', transition: 'background 0.2s' }} onMouseEnter={(e) => e.currentTarget.style.background = '#fafafa'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                                        <td data-label="Received" style={{ padding: '12px 10px' }} title={item.timestamp.toLocaleString()}>
                                            <div className={styles.receivedTime} style={{ fontWeight: '700', color: '#1e293b', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                                {item.timestamp.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                                                {Date.now() - item.timestamp.getTime() < 120000 && (
                                                    <span style={{
                                                        fontSize: '0.65rem',
                                                        background: '#4ade80',
                                                        color: '#fff',
                                                        padding: '1px 5px',
                                                        borderRadius: '10px',
                                                        animation: 'pulse 1.5s infinite',
                                                        fontWeight: 'bold'
                                                    }}>NEW</span>
                                                )}
                                            </div>
                                            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                                                {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        </td>
                                        <td data-label="Game Date" style={{ padding: '12px 10px' }}>
                                            <div style={{ fontWeight: '700', color: '#0369a1' }}>
                                                {formatGameDate(item.gameDate)}
                                            </div>
                                        </td>
                                        <td data-label="Time" style={{ padding: '12px 10px' }}>
                                            <div className={styles.gameTime}>{item.gameTime || item.bookingSlot || '-'}</div>
                                        </td>
                                        <td data-label="Platform" style={{ padding: '12px 10px' }}>
                                            <span
                                                className={styles.platformTag}
                                                style={{
                                                    background: item.platform === 'Playo' ? '#E8F5E9' :
                                                        item.platform === 'Hudle' ? '#E1F5FE' :
                                                            item.platform === 'Khelomore' ? '#FBE9E7' :
                                                                item.platform === 'System' ? '#F3E5F5' : '#ECEFF1',
                                                    color: item.platform === 'Playo' ? '#2E7D32' :
                                                        item.platform === 'Hudle' ? '#0277BD' :
                                                            item.platform === 'Khelomore' ? '#D84315' :
                                                                item.platform === 'System' ? '#6A1B9A' : '#37474F'
                                                }}
                                            >
                                                {item.platform}
                                            </span>
                                        </td>
                                        <td data-label="Sport" style={{ padding: '12px 10px' }}>
                                            <span
                                                className={styles.sportBadge}
                                                style={{
                                                    background: item.sport === 'Badminton' ? '#FFF3E0' : item.sport === 'Cricket' ? '#F3E5F5' : '#F5F5F5',
                                                    color: item.sport === 'Badminton' ? '#E65100' : item.sport === 'Cricket' ? '#7B1FA2' : '#616161'
                                                }}
                                            >
                                                {item.sport || 'General'}
                                            </span>
                                        </td>
                                        <td data-label="Customer" style={{ padding: '12px 10px' }}>
                                            <div style={{ fontSize: '0.85rem', color: '#334155', fontWeight: '500' }}>
                                                {item.bookingName || 'N/A'}
                                            </div>
                                        </td>
                                        <td data-label="Amount" style={{ padding: '12px 10px' }}>
                                            <span style={{
                                                fontSize: '0.85rem',
                                                color: item.paidAmount !== 'N/A' ? '#15803d' : '#64748b',
                                                background: item.paidAmount !== 'N/A' ? '#dcfce7' : '#f1f5f9',
                                                padding: '4px 10px',
                                                borderRadius: '6px',
                                                fontWeight: '700',
                                                display: 'inline-block'
                                            }}>
                                                {item.paidAmount || 'N/A'}
                                            </span>
                                        </td>
                                        <td data-label="Location" style={{ padding: '12px 10px' }}>
                                            <div className={styles.locationText}>{item.location}</div>
                                        </td>
                                        <td data-label="Manager" style={{ padding: '12px 10px' }}>
                                            <span style={{
                                                fontSize: '0.8rem',
                                                color: '#0d47a1',
                                                background: '#e3f2fd',
                                                padding: '2px 8px',
                                                borderRadius: '4px',
                                                fontWeight: '600'
                                            }}>
                                                {getManagerForLocation(item.location).name}
                                            </span>
                                        </td>
                                        <td data-label="Message" style={{ padding: '12px 10px', color: '#666', fontSize: '0.8rem' }}>
                                            {item.message.length > 50 ? item.message.substring(0, 50) + '...' : item.message}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <div className={styles.info}>
                    <p>Simulating user on Mobile (Turf Manager)</p>
                    <p><strong>Sound Active:</strong> Alerts will play a notification sound.</p>
                </div>
            </div>

            <div className={styles.alertContainer}>
                {alerts.map((alert, index) => (
                    <div key={alert.id} style={{ marginTop: index * 10 }}> {/* Stack effect */}
                        <AlertPopup {...alert} />
                    </div>
                ))}
            </div>
        </main >
    );
}
