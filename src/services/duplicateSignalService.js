import redisClient from '../config/redis.js';
import crypto from 'crypto';

class DuplicateSignalService {
    /**
     * Generate a unique fingerprint for a signal based on key identifying fields
     * @param {Object} signal - The signal object
     * @returns {string} - A hash fingerprint of the signal
     */
    generateSignalFingerprint(signal) {
        // Extract normalized signal fields
        const tt = signal.TT || signal.action || '';
        const ts = signal.TS || signal.symbol || '';
        const q = signal.Q || signal.quantity || '';
        const e = signal.E || signal.exchange || '';
        const ac = signal.AC || signal.account || '';
        const tp = signal.TP ?? signal.tp ?? signal.target ?? '';
        const sl = signal.SL ?? signal.sl ?? signal.stoploss ?? signal.stop_loss ?? '';

        // Create a string representation of the signal's identifying characteristics
        const signatureString = `${ac}:${ts}:${tt}:${q}:${e}:${tp}:${sl}`;

        // Generate a SHA256 hash
        const hash = crypto
            .createHash('sha256')
            .update(signatureString)
            .digest('hex');

        return `duplicate:signal:${hash}`;
    }

    /**
     * Check if a signal is a duplicate within the 45-second window
     * @param {Object} signal - The signal object
     * @returns {Promise<boolean>} - True if signal is a duplicate, false otherwise
     */
    async isDuplicateSignal(signal) {
        const key = this.generateSignalFingerprint(signal);

        // Try Redis first
        try {
            if (redisClient?.isReady) {
                const exists = await redisClient.exists(key);
                return exists === 1;
            }
        } catch (err) {
            console.warn('Redis check failed, falling back to memory:', err.message);
        }

        // Fallback to in-memory storage
        return this.inMemoryDuplicates.has(key);
    }

    /**
     * Register a signal as received (mark it for the 45-second window)
     * @param {Object} signal - The signal object
     * @param {number} ttlSeconds - Time to live in seconds (default: 45)
     * @returns {Promise<void>}
     */
    async markSignalAsReceived(signal, ttlSeconds = 45) {
        const key = this.generateSignalFingerprint(signal);

        // In-memory tracking
        const expiresAt = Date.now() + ttlSeconds * 1000;
        this.inMemoryDuplicates.set(key, expiresAt);

        // Schedule cleanup for expired in-memory entries
        this.scheduleInMemoryCleanup(key, ttlSeconds);

        // Try Redis
        try {
            if (redisClient?.isReady) {
                await redisClient.set(key, '1', { EX: ttlSeconds });
            }
        } catch (err) {
            console.warn('Redis set failed, using memory fallback:', err.message);
        }
    }

    /**
     * Clean up expired in-memory duplicate entries
     * @private
     */
    scheduleInMemoryCleanup(key, ttlSeconds) {
        setTimeout(() => {
            this.inMemoryDuplicates.delete(key);
        }, ttlSeconds * 1000);
    }

    /**
     * Initialize the in-memory storage
     * @private
     */
    constructor() {
        this.inMemoryDuplicates = new Map();

        // Periodic cleanup of expired in-memory entries (every 30 seconds)
        if (process.env.NODE_ENV !== 'test') {
            setInterval(() => {
                const now = Date.now();
                let cleaned = 0;

                for (const [key, expiresAt] of this.inMemoryDuplicates.entries()) {
                    if (expiresAt <= now) {
                        this.inMemoryDuplicates.delete(key);
                        cleaned++;
                    }
                }

                if (cleaned > 0) {
                    console.log(`[DuplicateSignalService] Cleaned up ${cleaned} expired signal entries`);
                }
            }, 30000);
        }
    }
}

export default new DuplicateSignalService();
