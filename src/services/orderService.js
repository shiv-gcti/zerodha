import kite from '../config/kite.js';
import instrumentService from './instrumentService.js';
import orderLogService from './orderLogService.js';
import positionService from './positionService.js';
import tpSlService from './tpSlService.js';
import kiteTickerService from './kiteTickerService.js';
import { getTradingStatus, isTradingEnabled } from './tradingControlService.js';
import redisClient from '../config/redis.js';
import { injectDefaultTPSL } from '../utils/defaultTPSL.js';

export const buildOrderPayload = async (signal) => {
    return await instrumentService.buildOrder(signal);
};

function extractOrderId(result) {
    if (!result) return null;
    if (typeof result === 'string' || typeof result === 'number') return String(result);
    return result.order_id || result.orderId || result.parent_order_id || null;
}

function makeCooldownKey({ accountId, symbol, transactionType }) {
    const a = accountId || 'UNKNOWN';
    const s = symbol || 'UNKNOWN';
    const t = transactionType || 'UNKNOWN';
    return `cooldown:order:${a}:${s}:${t}`;
}

function isBrokerOrderThrottle(message) {
    return /(maximum order|order exceeded|maximum orders|limit.*order|order limit|Maximum allowed order requests exceeded|allowed order requests exceeded|Kite order request cooldown active|rate.?limit|throttle|exceeded)/i.test(message);
}

// Cooldown prevents repeated/bursty attempts for the same order target.
// Prefer Redis when available, but fall back to in-memory if Redis is down.
const inMemoryCooldown = new Map();

async function isCooldownActive(key) {
    const now = Date.now();

    // Redis path
    try {
        if (redisClient?.isReady) {
            const ttl = await redisClient.ttl(key);
            return ttl > 0;
        }
    } catch {
        // ignore and fallback to memory
    }

    // Memory path
    const expiresAt = inMemoryCooldown.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= now) {
        inMemoryCooldown.delete(key);
        return false;
    }
    return true;
}

async function setCooldown(key, ttlSeconds) {
    const expiresAt = Date.now() + Math.max(0, ttlSeconds) * 1000;
    inMemoryCooldown.set(key, expiresAt);

    try {
        if (redisClient?.isReady) {
            await redisClient.set(key, '1', { EX: ttlSeconds });
        }
    } catch {
        // ignore; memory fallback is already set
    }
}

export const placeOrder = async (orderPayload) => {

    const accountId = orderPayload.accountId;


    if (!accountId) {
        throw new Error('accountId is missing');
    }

    const logId = await orderLogService.create(
        accountId,
        orderPayload
    );

    const symbol = orderPayload?.tradingsymbol;
    const transactionType = orderPayload?.transaction_type;
    const cooldownKey = makeCooldownKey({ accountId, symbol, transactionType });

    try {
        const tradingStatus = getTradingStatus();

        // Block retries for same symbol+side during cooldown.
        if (await isCooldownActive(cooldownKey)) {
            const reason = 'Cooldown active for this symbol/side. Skipping order placement.';

            await orderLogService.updateBlocked(logId, reason);

            return {
                blocked: true,
                dryRun: false,
                reason,
                tradingStatus,
                cooldown: true,
                orderPayload
            };
        }

        if (process.env.DRY_RUN === 'true') {


            await orderLogService.updateSuccess(
                logId,
                'DRY_RUN'
            );

            console.log('DRY RUN MODE');
            console.log(orderPayload);

            const position = await positionService.create(
                orderPayload,
                'DRY_RUN'
            );

            await tpSlService.registerEntry(position);

            return {
                dryRun: true,
                orderPayload
            };
        }

        if (!isTradingEnabled()) {
            const reason = 'Trading is OFF. Signal received but broker order was blocked.';

            // Avoid frequent retries after trading is toggled.
            await setCooldown(cooldownKey, 45);

            await orderLogService.updateBlocked(
                logId,
                reason
            );

            console.log(reason);
            console.log(orderPayload);

            return {
                blocked: true,
                dryRun: false,
                reason,
                tradingStatus,
                cooldown: true,
                orderPayload
            };
        }


        delete orderPayload.accountId;

        const orderResult = await kite.placeOrder(
            orderPayload,
            accountId
        );
        const orderId = extractOrderId(orderResult);


        if (!orderId) {
            throw new Error('Broker did not return an order_id');
        }

        await orderLogService.updateSuccess(
            logId,
            orderId
        );

        const position = await positionService.create(
            {
                ...orderPayload,
                accountId
            },
            orderId
        );

        await kiteTickerService.startForAccountId(accountId);
        await tpSlService.registerEntry(position);

        return {
            dryRun: false,
            orderId
        };

    } catch (error) {

        const msg = String(error?.message || error);

        const brokerOrderThrottle = isBrokerOrderThrottle(msg);

        // If broker limit is reached/exceeded, cooldown the same symbol+side.
        // This prevents repeated attempts from escalating broker limits.
        if (brokerOrderThrottle) {
            await setCooldown(cooldownKey, 45);
        }

        // Also cooldown on network/timeout-like errors to avoid tight retry loops.
        // Broker-side limits (or API throttling) often surface as NetworkException.
        if (/(NetworkException|ETIMEDOUT|ECONNRESET|timeout|socket|EAI_AGAIN)/i.test(msg)) {
            await setCooldown(cooldownKey, 45);
        }


        await orderLogService.updateFailed(
            logId,
            msg
        );

        if (brokerOrderThrottle) {
            return {
                blocked: true,
                dryRun: false,
                reason: msg,
                tradingStatus: getTradingStatus(),
                cooldown: true,
                orderPayload: {
                    ...orderPayload,
                    accountId
                }
            };
        }

        throw error;
    }
};

/**
 * Handle signal reversal - when a new signal comes for opposite direction
 * @param {Object} signal - The incoming signal
 * @param {Object} oppositePosition - The active opposite position
 * @returns {Promise<Object>} - Result of reversal handling
 */
export const handleSignalReversal = async (signal, oppositePosition) => {
    const accountId = signal.AC || signal.account;
    const symbol = signal.TS || signal.symbol;
    const exchange = signal.E || signal.exchange;
    const newTransactionType = String(signal.TT || signal.action).toUpperCase();

    console.log(`[REVERSAL] Handling signal reversal for ${symbol} | Old: ${oppositePosition.transaction_type} → New: ${newTransactionType}`);

    try {
        // Step 1: Cancel all exit orders (TP/SL/GTT)
        const exitOrdersCancelled = await tpSlService.cancelAllExitOrders(oppositePosition);
        
        if (!exitOrdersCancelled) {
            const errMsg = 'Failed to cancel all exit orders during reversal';
            console.error(`[REVERSAL] ${errMsg}`);
            await tpSlService.markManualExitRequired(oppositePosition, {
                label: 'REVERSAL',
                message: errMsg
            });
            throw new Error(errMsg);
        }

        // Step 2: Close the running position
        const positionClosed = await tpSlService.closePositionForReversal(oppositePosition);
        
        if (!positionClosed) {
            throw new Error('Failed to close running position for reversal');
        }

        console.log(`[REVERSAL] Position closed successfully. Ready to place reverse order.`);

        return {
            reversalHandled: true,
            oldPositionId: oppositePosition.id,
            oldTransactionType: oppositePosition.transaction_type,
            newTransactionType,
            readyForNewOrder: true
        };

    } catch (error) {
        console.error(`[REVERSAL] Failed to handle signal reversal: ${error?.message}`);
        throw error;
    }
};

/**
 * Check for active opposite position and handle reversal if found
 * @param {Object} signal - The incoming signal
 * @param {string} accountId
 * @returns {Promise<Object|null>} - Reversal result or null if no opposite position
 */
export const checkAndHandleReversal = async (signal, accountId) => {
    const symbol = signal.TS || signal.symbol;
    const exchange = signal.E || signal.exchange;
    const transactionType = signal.TT || signal.action;

    if (!symbol || !exchange || !transactionType) {
        return null;
    }

    // Check if there's an active opposite position
    const oppositePosition = await positionService.getActiveOppositePosition(
        accountId,
        symbol,
        exchange,
        transactionType
    );

    if (!oppositePosition) {
        return null; // No reversal needed
    }

    // Signal reversal detected - handle it
    console.log(`[REVERSAL] Opposite position detected: ${oppositePosition.id}`);
    
    const reversalResult = await handleSignalReversal(signal, oppositePosition);
    
    // Inject default TP/SL for the new reverse order
    const signalWithDefaults = injectDefaultTPSL(reversalResult.signal || signal);
    
    return {
        ...reversalResult,
        signal: signalWithDefaults,
        tpslInfo: signalWithDefaults._tpslInfo
    };
};
