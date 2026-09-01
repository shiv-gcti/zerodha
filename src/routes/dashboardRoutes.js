import express from 'express';
import { ACCOUNTS } from '../config/accounts.js';
import db from '../services/dbService.js';
import kite from '../config/kite.js';
import tradeLifecycleService from '../services/tradeLifecycleService.js';

const router = express.Router();

function getTargetAccounts(accountId) {
    if (!accountId || accountId === 'ALL') {
        return ACCOUNTS;
    }

    return ACCOUNTS.filter(account => account.id === accountId);
}

function normalizePayload(payload) {
    if (!payload) return {};
    if (typeof payload === 'object') return payload;

    try {
        return JSON.parse(payload);
    } catch (_) {
        return {};
    }
}

function getOrderSymbol(payload) {
    return payload.tradingsymbol || payload.TS || payload.symbol || '-';
}

function getOrderQuantity(payload) {
    return payload.quantity || payload.Q || '-';
}

function getOrderPrice(payload) {
    return payload.price || payload.PR || payload.trigger_price || '-';
}

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function isToday(value) {
    if (!value) return false;

    const date = new Date(value);
    const now = new Date();

    return date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
}

function getOrderTime(order) {
    if (!order || typeof order !== 'object') {
        return null;
    }

    return order.order_timestamp
        || order.exchange_timestamp
        || order.exchange_update_timestamp
        || order.created_at
        || null;
}

function getFilledQuantity(order) {
    return toFiniteNumber(order.filled_quantity ?? order.quantity ?? order.pending_quantity);
}

function getAverageOrderPrice(order) {
    return toFiniteNumber(order.average_price ?? order.price);
}

function getPositionGroupKey(value) {
    return String(value || '').trim().toUpperCase();
}

function ordersMatchPosition(order, position) {
    const orderProduct = getPositionGroupKey(order.product);
    const positionProduct = getPositionGroupKey(position.product);

    return getPositionGroupKey(order.tradingsymbol) === getPositionGroupKey(position.tradingsymbol)
        && getPositionGroupKey(order.exchange) === getPositionGroupKey(position.exchange)
        && (!orderProduct || !positionProduct || orderProduct === positionProduct);
}

function calculateActiveCycleEntryPrice(orders) {
    let runningQuantity = 0;
    let averageEntryPrice = 0;

    const sortedOrders = [...orders].sort((a, b) => {
        const timeA = new Date(getOrderTime(a) || 0).getTime();
        const timeB = new Date(getOrderTime(b) || 0).getTime();

        if (timeA !== timeB) return timeA - timeB;

        return String(a.order_id || '').localeCompare(String(b.order_id || ''));
    });

    for (const order of sortedOrders) {
        const side = String(order.transaction_type || '').toUpperCase();
        const quantity = getFilledQuantity(order);
        const price = getAverageOrderPrice(order);

        if (!['BUY', 'SELL'].includes(side) || quantity === null || quantity <= 0 || price === null || price <= 0) {
            continue;
        }

        const signedQuantity = side === 'BUY' ? quantity : -quantity;

        if (runningQuantity === 0 || Math.sign(runningQuantity) === Math.sign(signedQuantity)) {
            const totalQuantity = Math.abs(runningQuantity) + Math.abs(signedQuantity);
            averageEntryPrice = totalQuantity === 0
                ? 0
                : ((Math.abs(runningQuantity) * averageEntryPrice) + (Math.abs(signedQuantity) * price)) / totalQuantity;
            runningQuantity += signedQuantity;
            continue;
        }

        const remainingQuantity = runningQuantity + signedQuantity;

        if (remainingQuantity === 0) {
            runningQuantity = 0;
            averageEntryPrice = 0;
        } else if (Math.sign(remainingQuantity) === Math.sign(runningQuantity)) {
            runningQuantity = remainingQuantity;
        } else {
            runningQuantity = remainingQuantity;
            averageEntryPrice = price;
        }
    }

    return runningQuantity === 0 || averageEntryPrice <= 0
        ? null
        : Number(averageEntryPrice.toFixed(2));
}

function formatOrderStatus(status, orderId) {
    const normalized = String(status || '').toUpperCase();
    const normalizedOrderId = String(orderId || '').toUpperCase();

    if ((normalized === 'PLACED' || normalized === 'COMPLETE') && normalizedOrderId !== 'DRY_RUN') {
        return 'Order Placed';
    }

    return 'Cancelled';
}

function calculatePositionPnl(row) {
    const entryPrice = Number(row.price);
    const ltp = Number(row.ltp);
    const quantity = Number(row.quantity);

    if (!Number.isFinite(entryPrice) || !Number.isFinite(ltp) || !Number.isFinite(quantity)) {
        return null;
    }

    return Number(((ltp - entryPrice) * quantity).toFixed(2));
}

async function attachLtpFromStockSymbols(rows) {
    const symbols = [
        ...new Set(
            (rows || [])
                .map(row => String(row.symbol || '').trim())
                .filter(symbol => symbol && symbol !== '-')
        )
    ];

    if (symbols.length === 0) {
        return rows;
    }

    const placeholders = symbols.map(() => '?').join(', ');
    const result = await db.query(
        `
        SELECT name, ltp
        FROM stock_symbols
        WHERE name IN (${placeholders})
        `,
        symbols
    );

    const ltpByName = new Map(
        result.rows.map(row => [row.name, row.ltp])
    );

    return rows.map(row => {
        const enrichedRow = {
            ...row,
            ltp: ltpByName.get(row.symbol) ?? null
        };

        return {
            ...enrichedRow,
            pnl: calculatePositionPnl(enrichedRow)
        };
    });
}

async function getBrokerOpenPositionsToday(targetAccounts, options = {}) {
    const rows = [];

    for (const account of targetAccounts) {
        try {
            const kc = await kite.getInstance(account.id);
            const [positions, orders] = await Promise.all([
                kc.getPositions(),
                kc.getOrders()
            ]);

            const safeOrders = (orders || []).filter(Boolean);
            const todayOrders = safeOrders.filter(order => isToday(getOrderTime(order)));
            const completedTodayOrders = todayOrders.filter(order => String(order?.status || '').toUpperCase() === 'COMPLETE');
            const dayPositions = (positions?.day || []).filter(Boolean);

            for (const position of dayPositions) {
                const quantity = Number(position.quantity ?? position.net_quantity ?? 0);

                if (!Number.isFinite(quantity) || quantity === 0) {
                    continue;
                }

                const matchingOrder = todayOrders
                    .filter(order => {
                        if (!order || typeof order !== 'object') {
                            return false;
                        }

                        const orderStatus = String(order.status || '').toUpperCase();

                        return orderStatus === 'COMPLETE'
                            && order.tradingsymbol === position.tradingsymbol
                            && order.exchange === position.exchange;
                    })
                    .sort((a, b) => new Date(getOrderTime(b)) - new Date(getOrderTime(a)))[0];
                const activeCycleOrders = completedTodayOrders.filter(order => ordersMatchPosition(order, position));
                const activeCycleEntryPrice = calculateActiveCycleEntryPrice(activeCycleOrders);

                rows.push({
                    accountId: account.id,
                    time: getOrderTime(matchingOrder) || new Date(),
                    symbol: position.tradingsymbol || '-',
                    quantity,
                    price: activeCycleEntryPrice ?? position.average_price ?? matchingOrder?.average_price ?? '-'
                });
            }
        } catch (accountError) {
            console.error(
                `Failed to fetch open positions for account ${account.id}`,
                accountError.message
            );
        }
    }

    if (!options.includeLtp) {
        return rows;
    }

    return attachLtpFromStockSymbols(rows);
}

router.get('/accounts', (req, res) => {
    res.json({
        success: true,
        accounts: [
            'ALL',
            ...ACCOUNTS.map(account => account.id)
        ]
    });
});

router.get('/summary', async (req, res) => {
    try {
        const accountId = String(req.query.account || 'ALL').trim();
        const targetAccounts = getTargetAccounts(accountId);
        await tradeLifecycleService.ensureSchema();

        if (targetAccounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: `Unknown account: ${accountId}`
            });
        }

        const params = [];
        const accountFilter = accountId !== 'ALL' ? 'AND account_id = $1' : '';

        if (accountId !== 'ALL') {
            params.push(accountId);
        }

        const ordersResult = await db.query(
            `
            SELECT COUNT(*)::int AS total
            FROM order_logs
            WHERE created_at::date = CURRENT_DATE
            ${accountFilter}
            `,
            params
        );

        const openPositionRows = await getBrokerOpenPositionsToday(targetAccounts, { includeLtp: true });
        const openPositionsPnl = openPositionRows.reduce((total, row) => {
            const pnl = Number(row.pnl);
            return Number.isFinite(pnl) ? total + pnl : total;
        }, 0);

        res.json({
            success: true,
            account: accountId,
            ordersToday: Number(ordersResult.rows[0]?.total || 0),
            openPositions: openPositionRows.length,
            openPositionsPnl: Number(openPositionsPnl.toFixed(2))
        });
    } catch (err) {
        console.error('/dashboard/summary error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

router.get('/orders/today', async (req, res) => {
    try {
        const accountId = String(req.query.account || 'ALL').trim();
        const targetAccounts = getTargetAccounts(accountId);

        if (targetAccounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: `Unknown account: ${accountId}`
            });
        }

        const params = [];
        const accountFilter = accountId !== 'ALL' ? 'AND account_id = $1' : '';

        if (accountId !== 'ALL') {
            params.push(accountId);
        }

        const result = await db.query(
            `
            SELECT created_at,
                   account_id,
                   payload,
                   order_id,
                   status
            FROM order_logs
            WHERE created_at::date = CURRENT_DATE
            ${accountFilter}
            ORDER BY created_at DESC
            `,
            params
        );

        const rows = result.rows.map(row => {
            const payload = normalizePayload(row.payload);

            return {
                accountId: row.account_id,
                time: row.created_at,
                symbol: getOrderSymbol(payload),
                quantity: getOrderQuantity(payload),
                price: getOrderPrice(payload),
                status: formatOrderStatus(row.status, row.order_id),
                orderId: row.order_id
            };
        });

        res.json({
            success: true,
            account: accountId,
            rows
        });
    } catch (err) {
        console.error('/dashboard/orders/today error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

router.get('/positions/today', async (req, res) => {
    try {
        const accountId = String(req.query.account || 'ALL').trim();
        const targetAccounts = getTargetAccounts(accountId);

        if (targetAccounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: `Unknown account: ${accountId}`
            });
        }

        const rows = await getBrokerOpenPositionsToday(targetAccounts, { includeLtp: true });

        res.json({
            success: true,
            account: accountId,
            rows
        });
    } catch (err) {
        console.error('/dashboard/positions/today error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

router.get('/manual-exit-alerts', async (req, res) => {
    try {
        const accountId = String(req.query.account || 'ALL').trim();
        const targetAccounts = getTargetAccounts(accountId);

        if (targetAccounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: `Unknown account: ${accountId}`
            });
        }

        const params = [];
        const accountFilter = accountId !== 'ALL' ? 'AND account_id = $1' : '';

        if (accountId !== 'ALL') {
            params.push(accountId);
        }

        const result = await db.query(
            `
            SELECT id,
                   account_id,
                   tradingsymbol,
                   exchange,
                   quantity,
                   transaction_type,
                   product,
                   entry_order_id,
                   entry_price,
                   target_price,
                   stoploss_price,
                   last_error,
                   updated_at
            FROM trade_positions
            WHERE lifecycle_status = 'MANUAL_EXIT_REQUIRED'
              AND status IN ('OPEN','ACTIVE')
            ${accountFilter}
            ORDER BY updated_at DESC, id DESC
            `,
            params
        );

        res.json({
            success: true,
            account: accountId,
            rows: result.rows.map(row => ({
                tradeId: row.id,
                accountId: row.account_id,
                tradingsymbol: row.tradingsymbol,
                exchange: row.exchange,
                quantity: row.quantity,
                transactionType: row.transaction_type,
                product: row.product,
                entryOrderId: row.entry_order_id,
                entryPrice: row.entry_price,
                targetPrice: row.target_price,
                stopLossPrice: row.stoploss_price,
                message: row.last_error || 'Automatic exit order failed. Please exit this position manually.',
                updatedAt: row.updated_at
            }))
        });
    } catch (err) {
        console.error('/dashboard/manual-exit-alerts error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

export default router;
