import React, { useEffect, useState } from 'react';
import styles from './AlertPopup.module.css';

export interface AlertProps {
    id: string;
    platform: 'Playo' | 'Hudle' | 'District' | 'Khelomore' | 'System';
    message: string;
    location: string;
    timestamp: Date;
    bookingSlot?: string;
    sport?: string;
    bookingName?: string;
    paidAmount?: string;
    onDismiss: (id: string) => void;
}

const getPlatformStyle = (platform: string) => {
    switch (platform) {
        case 'Playo':
            return styles.playo;
        case 'Hudle':
            return styles.hudle;
        case 'District':
            return styles.district;
        case 'Khelomore':
            return styles.khelomore;
        case 'System':
            return styles.system;
        default:
            return styles.default;
    }
};

const AlertPopup: React.FC<AlertProps> = ({ id, platform, message, location, timestamp, bookingSlot, sport, bookingName, paidAmount, onDismiss }) => {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        setIsVisible(true);
        // Auto dismiss after 10 seconds
        const timer = setTimeout(() => {
            handleDismiss();
        }, 10000);
        return () => clearTimeout(timer);
    }, []);

    const handleDismiss = () => {
        setIsVisible(false);
        setTimeout(() => onDismiss(id), 300); // Wait for animation
    };

    const formatTime = (date: Date) => {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const formatDate = (date: Date) => {
        return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
    };

    return (
        <div className={`${styles.popup} ${getPlatformStyle(platform)} ${isVisible ? styles.visible : ''}`}>
            <div className={styles.header}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className={styles.platformName} style={{
                            background: 'rgba(255,255,255,0.2)',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '0.75rem'
                        }}>
                            {platform}
                        </span>
                        {sport && (
                            <span style={{
                                background: 'rgba(0,0,0,0.2)',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '0.75rem',
                                fontWeight: 'bold',
                                textTransform: 'uppercase'
                            }}>
                                {sport}
                            </span>
                        )}
                    </div>
                    <div className={styles.dateTime}>
                        <span>{formatDate(timestamp)}</span> • <span>{formatTime(timestamp)}</span>
                    </div>
                </div>
                <button onClick={handleDismiss} className={styles.closeBtn}>&times;</button>
            </div>
            <div className={styles.body}>
                {bookingSlot && (
                    <div className={styles.slotDisplay}>
                        <span className={styles.gameTimeLabel}>Actual Game Time</span>
                        <p className={styles.actualTime}>🕒 {bookingSlot}</p>
                    </div>
                )}
                <p className={styles.locationTitle}>📍 {location}</p>
                {bookingName && bookingName !== 'N/A' && (
                    <p style={{ margin: '4px 0', fontSize: '0.9rem', color: '#334155' }}>
                        <strong>Customer:</strong> {bookingName}
                    </p>
                )}
                {paidAmount && paidAmount !== 'N/A' && (
                    <p style={{ margin: '4px 0', fontSize: '0.95rem', fontWeight: 'bold', color: '#15803d' }}>
                        💰 {paidAmount}
                    </p>
                )}
                <p className={styles.message}>{message}</p>
            </div>
        </div>
    );
};

export default AlertPopup;
