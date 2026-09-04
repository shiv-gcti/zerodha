import { KiteConnect } from 'kiteconnect';
import { ACCOUNTS } from './accounts.js';
import tokenManager from '../services/tokenManager.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import { normalizeBrokerProduct } from '../utils/orderPayload.js';

const orderRequestLimiter = createRateLimiter({
    ratePerInterval: Number(process.env.KITE_ORDER_REQUEST_RATE_PER_INTERVAL || process.env.KITE_PLACE_ORDER_RATE_PER_INTERVAL || 1),
    intervalMs: Number(process.env.KITE_ORDER_REQUEST_INTERVAL_MS || process.env.KITE_PLACE_ORDER_INTERVAL_MS || 1500)
});

const orderRequestCooldownUntilByAccount = new Map();

function getOrderRequestCooldownMs() {
    return Number(process.env.KITE_ORDER_REQUEST_COOLDOWN_MS || 120000);
}

function getCooldownUntil(accountId) {
    return orderRequestCooldownUntilByAccount.get(accountId) || 0;
}

function isOrderRequestThrottle(error) {
    const message = String(error?.message || error);
    return /Maximum allowed order requests exceeded|allowed order requests exceeded|rate.?limit|throttle/i.test(message);
}

function describeKiteError(error) {
    return {
        message: error?.message || String(error),
        status: error?.status,
        error_type: error?.error_type,
        data: error?.data,
        name: error?.name
    };
}

function logOrderLimitDiagnosis({ accountId, variety, orderParams, error }) {
    console.warn('[KITE_ORDER_LIMIT_DIAGNOSIS]', {
        accountId,
        variety,
        orderParams,
        brokerMessage: error?.message || String(error),
        likelyCause: 'Zerodha rejected the order request before creating an order. This is enforced by Kite/Zerodha, not by local TP/SL code.',
        zerodhaLimits: {
            orderPlacementRate: '10 order placements/second',
            orderRequestsPerMinute: '400 order requests/minute',
            orderRequestsPerDay: '5000 order requests/day per user/API key across segments and varieties',
            includesInvalidRequests: true
        },
        nextStep: 'Stop sending order requests for this API key/account until the Zerodha limit window resets, or contact Zerodha if the daily limit should not be exhausted.'
    });
}

function setOrderRequestCooldown(accountId) {
    const until = Date.now() + getOrderRequestCooldownMs();
    orderRequestCooldownUntilByAccount.set(accountId, until);
    return until;
}

function withTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runOrderRequest(accountId, label, meta, fn) {
    const cooldownUntil = getCooldownUntil(accountId);

    if (cooldownUntil > Date.now()) {
        throw new Error(`${label} blocked: Kite order request cooldown active until ${new Date(cooldownUntil).toISOString()}`);
    }

    return await orderRequestLimiter(async () => {
        console.log(`[${label}]`, {
            ts: Date.now(),
            accountId,
            ...meta
        });

        try {
            return await fn();
        } catch (error) {
            console.error('[KITE_ORDER_ERROR]', {
                accountId,
                label,
                error: describeKiteError(error)
            });

            if (isOrderRequestThrottle(error)) {
                const until = setOrderRequestCooldown(accountId);
                console.warn('[KITE_ORDER_COOLDOWN]', {
                    accountId,
                    until: new Date(until).toISOString()
                });
            }

            throw error;
        }
    });
}


const BROKER_ORDER_FIELDS = new Set([
    'exchange',
    'tradingsymbol',
    'transaction_type',
    'quantity',
    'order_type',
    'product',
    'validity',
    'price',
    'trigger_price',
    'disclosed_quantity',
    'market_protection',
    'tag',
    'autoslice'
]);

function sanitizeOrderPayload(orderPayload) {
    return Object.fromEntries(
        Object.entries(orderPayload || {})
            .filter(([key, value]) => BROKER_ORDER_FIELDS.has(key) && value !== null && value !== undefined && value !== '')
    );
}

function describeGttPayload(gttPayload) {
    return {
        trigger_type: gttPayload?.trigger_type,
        exchange: gttPayload?.exchange,
        tradingsymbol: gttPayload?.tradingsymbol,
        trigger_values: gttPayload?.trigger_values,
        last_price: gttPayload?.last_price,
        orders: gttPayload?.orders
    };
}

class KiteService {

async getInstance(accountId) {

    if (!accountId) {
        throw new Error('accountId is required');
    }

    const account = ACCOUNTS.find(
        a => a.id === accountId
    );

    if (!account) {
        throw new Error(`Account not found: ${accountId}`);
    }

    const accessToken =
        await tokenManager.getToken(accountId);

    if (!accessToken) {
        throw new Error(
            `No token found for account ${accountId}`
        );
    }



    const kite = new KiteConnect({
        api_key: account.apiKey
    });

    kite.setAccessToken(accessToken);

    return kite;
}


async placeOrder(orderPayload, accountId) {

    if (!accountId) {
        throw new Error('accountId is required');
    }

    const account = ACCOUNTS.find(
        a => a.id === accountId
    );

    if (!account) {
        throw new Error(`Account not found: ${accountId}`);
    }

    if (!account.apiKey) {
        throw new Error(
            `No Zerodha API key configured for account ${accountId}`
        );
    }

const now = new Date();

const istTime = new Date(
    now.toLocaleString("en-US", {
        timeZone: "Asia/Kolkata"
    })
);

const currentMinutes =
    istTime.getHours() * 60 + istTime.getMinutes();

const product = normalizeBrokerProduct(orderPayload.product, 'NRML');
const orderType = String(orderPayload.order_type || '').toUpperCase();

let isRegularOrderAllowed = false;

if (product === 'NRML') {
    // 09:00 AM to 11:25 PM
    const start = 9 * 60;          // 09:00
    const end = 23 * 60 + 30;      // 23:30

    isRegularOrderAllowed =
        currentMinutes >= start &&
        currentMinutes <= end;

} else if (product === 'CNC') {
    // 09:15 AM to 03:25 PM
    const start = 9 * 60 + 15;     // 09:15
    const end = 15 * 60 + 30;      // 15:30

    isRegularOrderAllowed =
        currentMinutes >= start &&
        currentMinutes <= end;

} else {
    // MIS and all other products
    // 09:15 AM to 03:30 PM
    const start = 9 * 60 + 15;     // 09:15
    const end = 15 * 60 + 30;      // 15:30

    isRegularOrderAllowed =
        currentMinutes >= start &&
        currentMinutes <= end;
}

if (product === 'CNC' && orderType === 'MARKET' && !isRegularOrderAllowed) {
    throw new Error('CNC market orders are blocked outside regular market hours; use regular order timing or switch to a supported product.');
}

const variety = isRegularOrderAllowed
    ? 'regular'
    : 'amo';

if (product === 'CNC' && orderType === 'MARKET' && !isRegularOrderAllowed) {
    throw new Error('CNC market orders are blocked outside regular market hours; use regular order timing or switch to a supported product.');
}

console.log(
    `📌 Placing ${variety.toUpperCase()} order for ${accountId}`,
    {
        product,
        time: istTime.toLocaleTimeString('en-IN'),
        isRegularOrderAllowed
    }
);

    const orderParams = sanitizeOrderPayload(orderPayload);

    if (orderParams.order_type === 'MARKET') {
        console.log('[ORDER] MARKET order detected - applying market_protection=-1');
        orderParams.market_protection = -1;
    }

    // FIX: Get Kite instance
    const kc = await this.getInstance(accountId);

    return await runOrderRequest(
        accountId,
        'KITE_PLACE_ORDER',
        { variety, orderParams },
        async () => {
            try {
                const result = await withTimeout(
                    kc.placeOrder(variety, orderParams),
                    Number(process.env.KITE_ORDER_TIMEOUT_MS || 30000),
                    'Kite order placement'
                );
                console.log('[KITE_ORDER_ACCEPTED]', {
                    accountId,
                    variety,
                    orderId: result?.order_id || result?.orderId || null,
                    exchange: orderParams.exchange,
                    tradingsymbol: orderParams.tradingsymbol
                });
                return result;
            } catch (error) {
                console.error('[KITE_ORDER_REJECTED]', {
                    accountId,
                    variety,
                    exchange: orderParams.exchange,
                    tradingsymbol: orderParams.tradingsymbol,
                    error: describeKiteError(error)
                });
                if (isOrderRequestThrottle(error)) {
                    logOrderLimitDiagnosis({
                        accountId,
                        variety,
                        orderParams,
                        error
                    });
                }
                throw error;
            }
        }
    );
}

async cancelOrder(orderId, accountId) {

    if (!accountId) {
        throw new Error('accountId is required');
    }

    const kc = await this.getInstance(accountId);
    return await runOrderRequest(accountId, 'KITE_CANCEL_ORDER', { orderId }, async () => {
        return await kc.cancelOrder('regular', orderId);
    });
}

async placeGTT(gttPayload, accountId) {

    if (!accountId) {
        throw new Error('accountId is required');
    }

    const kc = await this.getInstance(accountId);
    const payload = {
        ...gttPayload,
        trigger_values: (gttPayload.trigger_values || []).map(Number),
        last_price: Number(gttPayload.last_price),
        orders: (gttPayload.orders || []).map(order => ({
            ...order,
            quantity: Number(order.quantity),
            price: Number(order.price)
        }))
    };

    return await runOrderRequest(accountId, 'KITE_PLACE_GTT', describeGttPayload(payload), async () => {
        return await kc.placeGTT(payload);
    });
}

async deleteGTT(gttId, accountId) {

    if (!accountId) {
        throw new Error('accountId is required');
    }

    const kc = await this.getInstance(accountId);

    return await runOrderRequest(accountId, 'KITE_DELETE_GTT', { gttId }, async () => {
        try {
            return await kc.deleteGTT(String(gttId));
        } catch (error) {
            if (isOrderRequestThrottle(error)) {
                logOrderLimitDiagnosis({ accountId, variety: 'gtt_delete', orderParams: { gttId }, error });
            }
            throw error;
        }
    });
}

async getLTP(accountId, exchange, tradingsymbol) {

    if (!accountId) {
        throw new Error('accountId is required');
    }

    const kc = await this.getInstance(accountId);
    const instrument = `${exchange}:${tradingsymbol}`;
    const data = await kc.getLTP([instrument]);
    return Number(data?.[instrument]?.last_price || 0) || null;
}


}

export default new KiteService();
