// frontend/src/components/TelemetryProgress.jsx
import React from 'react';

export default function TelemetryProgress({ packetsSent = 0, totalPackets = 10000 }) {
    // 1. Calculate strictly bounded percentage [0, 100] to prevent CSS width overflow
    const rawRatio = totalPackets > 0 ? (packetsSent / totalPackets) * 100 : 0;
    const boundedPercentage = Math.min(100, Math.max(0, Math.round(rawRatio)));

    return (
        <div style={styles.panel}>
            <h3 style={styles.header}>Packet Transmission Status</h3>
            
            {/* Safe Progress Track */}
            <div style={styles.track}>
                <div style={{
                    ...styles.fill,
                    width: `${boundedPercentage}%`
                }} />
            </div>

            {/* Metadata Labels */}
            <div style={styles.metadata}>
                <span>
                    Transmitted: <strong>{packetsSent.toLocaleString()} / {totalPackets.toLocaleString()}</strong> packets
                </span>
                <span style={styles.badge}>{boundedPercentage}%</span>
            </div>
        </div>
    );
}

const styles = {
    panel: {
        backgroundColor: '#1e1e1e',
        border: '1px solid #333',
        borderRadius: '8px',
        padding: '20px',
        color: '#e0e0e0',
        fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
        maxWidth: '600px',
        margin: '10px 0'
    },
    header: {
        marginTop: 0,
        fontSize: '1rem',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: '#888'
    },
    track: {
        width: '100%',
        height: '24px',
        backgroundColor: '#2a2a2a',
        borderRadius: '12px',
        overflow: 'hidden',
        border: '1px solid #3f3f3f',
        marginBottom: '12px'
    },
    fill: {
        height: '100%',
        background: 'linear-gradient(90deg, #2563eb, #3b82f6)',
        transition: 'width 0.15s ease-out'
    },
    metadata: {
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '0.9rem',
        fontFamily: 'monospace'
    },
    badge: {
        background: '#2d3748',
        padding: '2px 8px',
        borderRadius: '4px',
        color: '#63b3ed'
    }
};