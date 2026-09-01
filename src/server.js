import http from "http";

import express from 'express';

import webhookRoutes from './routes/webhookRoutes.js';
import zerodhaRoutes from './routes/zerodhaRoutes.js';
import tradingControlRoutes from './routes/tradingControlRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import websocketRoutes from './routes/websocketRoutes.js';


import { startInstrumentSyncJob, syncInstrumentsIfNeeded } from './jobs/instrumentSyncJob.js';
import { startTokenSyncJob } from './jobs/tokenSyncJob.js';
import { startOrderSyncJob } from './jobs/orderSyncJob.js';
import { startActiveTradeMonitorJob } from './jobs/activeTradeMonitorJob.js';
import { startCleanupJob } from './jobs/cleanupJob.js';

import {startStockSymbolFillerJob,stopStockSymbolFillerJob} from './jobs/stockSymbolFillerJob.js';
import angelAuthService from "./services/angelAuthService.js";
import angelWebSocketService from "./services/angelWebSocketService.js";

import { startAngelTokenJob } from "./jobs/angelTokenJob.js";
import { startAngelInstrumentJob } from './jobs/angelInstrumentJob.js';
import angelInstrumentService  from './services/angelInstrumentService.js';




import cors from "cors";
import db from "./services/dbService.js";
import positionService from "./services/positionService.js";
import kite from "./config/kite.js";
import { ACCOUNTS } from './config/accounts.js';

import { initSocket } from "./socket/socketServer.js";
import fs from 'fs';
import path from 'path';

function envFlag(name, defaultValue = true) {
    const value = process.env[name];
    if (value === undefined || value === '') return defaultValue;
    return String(value).toLowerCase() === 'true';
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

if (envFlag("ENABLE_ANGEL_TOKEN_JOB", true)) {
    startAngelTokenJob();
}

if (envFlag('ENABLE_ANGEL_INSTRUMENT_JOB', true)) {
    startAngelInstrumentJob();
}

// start jobs
if (envFlag('ENABLE_INSTRUMENT_SYNC_JOB', true)) {
    startInstrumentSyncJob();
    syncInstrumentsIfNeeded().catch(() => {});
}

if (envFlag(
    'ENABLE_STOCK_SYMBOL_FILLER_JOB',
    true
)) {

    startStockSymbolFillerJob();
}

if (envFlag('ENABLE_TOKEN_SYNC_JOB', true)) {
    startTokenSyncJob();
}

if (envFlag('ENABLE_ORDER_SYNC_JOB', true)) {
    startOrderSyncJob();
}

if (envFlag('ENABLE_ACTIVE_TRADE_MONITOR_JOB', true)) {
    startActiveTradeMonitorJob();
}

if (envFlag('ENABLE_CLEANUP_JOB', true)) {
    startCleanupJob();
}

const app = express();

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());



import instrumentsRoutes from './routes/instrumentsRoutes.js';

app.use('/webhook', webhookRoutes);
app.use('/zerodha', zerodhaRoutes);
app.use('/trading', tradingControlRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/instruments', instrumentsRoutes);
app.use('/api/websocket', websocketRoutes);


import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'webhook-payload-builder.html'));
});

app.get("/orders/open", async (req, res) => {
    try {

        const requestedAccount = req.query.account;
        const targetAccounts = requestedAccount
            ? ACCOUNTS.filter(a => a.id === requestedAccount)
            : ACCOUNTS;

        if (requestedAccount && targetAccounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: `Unknown account: ${requestedAccount}`
            });
        }

        const allOpenOrders = [];

        for (const account of targetAccounts) {
            try {
                const kc = await kite.getInstance(account.id);
                const orders = await kc.getOrders();

                const openOrders = orders
                    .filter(o => {
                        const status = String(o.status || "").toUpperCase();
                        const pendingQty = Number(o.pending_quantity || o.quantity || 0);
                        return (
                            pendingQty > 0 &&
                            !status.includes("COMPLETE") &&
                            !status.includes("CANCELLED")
                        );
                    })
                    .map(o => ({
                        ...o,
                        account_id: account.id
                    }));

                allOpenOrders.push(...openOrders);
            } catch (accountError) {
                console.error(
                    `❌ Failed to fetch open orders for account ${account.id}`,
                    accountError.message
                );
            }
        }

        res.json(allOpenOrders);

    } catch (err) {
        console.error('/orders error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/orders', async (req, res) => {
    try {
        const requestedAccount = req.query.account;
        const params = [];
        const filter = requestedAccount ? 'WHERE account_id = $1' : '';

        if (requestedAccount) {
            params.push(requestedAccount);
        }

        const result = await db.query(
            `
            SELECT id,
                   created_at,
                   account_id,
                   payload,
                   order_id,
                   status,
                   error_message
            FROM order_logs
            ${filter}
            ORDER BY created_at DESC
            `,
            params
        );

        res.json(result.rows);
    } catch (err) {
        console.error('/pending-orders error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/pending-orders', async (req, res) => {
    try {
        const requestedAccount = req.query.account;
        const targetAccounts = requestedAccount
            ? ACCOUNTS.filter(a => a.id === requestedAccount)
            : ACCOUNTS;

        if (requestedAccount && targetAccounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: `Unknown account: ${requestedAccount}`
            });
        }

        const pendingStatuses = new Set([
            'OPEN',
            'TRIGGER PENDING',
            'VALIDATION PENDING'
        ]);

        const allPendingOrders = [];

        for (const account of targetAccounts) {
            try {
                const kc = await kite.getInstance(account.id);
                const orders = await kc.getOrders();

                const filtered = orders
                    .filter(o => pendingStatuses.has(String(o.status || '').toUpperCase()))
                    .map(o => ({
                        ...o,
                        account_id: account.id
                    }));

                allPendingOrders.push(...filtered);
            } catch (accountError) {
                console.error(
                    `❌ Failed to fetch pending orders for account ${account.id}`,
                    accountError.message
                );
            }
        }

        res.json(allPendingOrders);
    } catch (err) {
        console.error('/trades error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/trades', async (req, res) => {
    try {
        const requestedAccount = req.query.account;
        const params = [];
        const filter = requestedAccount ? 'WHERE account_id = $1' : '';

        if (requestedAccount) {
            params.push(requestedAccount);
        }

        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            ${filter}
            ORDER BY id DESC
            `,
            params
        );

        res.json(result.rows);
    } catch (err) {
        console.error('/pnl error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/pnl', async (req, res) => {
    try {
        const requestedAccount = req.query.account;
        const todayOnly = String(req.query.today || '').toLowerCase() === 'true';

        let positions = requestedAccount
            ? await positionService.getOpenPositionsByAccount(requestedAccount)
            : await positionService.getOpenPositions();

        if (todayOnly) {
            const today = new Date();
            positions = (positions || []).filter(p => {
                const created = p.created_at || p.createdAt || p.created;
                if (!created) return false;
                const d = new Date(created);
                return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
            });

        }

        const totals = {
            PM: 0,
            PDM: 0,
            PSM: 0,
            SHIV: 0,
            total: 0
        };

        for (const position of positions) {
            const entryPrice = Number(position.entry_price ?? position.average_price ?? 0);
            const quantity = Number(position.quantity ?? 0);
            const ltpSource = await marketDataService.getPrice(`${position.exchange}:${position.tradingsymbol}`)
                || await marketDataService.getPrice(position.tradingsymbol);

            const ltp = Number(ltpSource?.ltp ?? 0);

            if (!Number.isFinite(entryPrice) || !Number.isFinite(ltp) || quantity === 0) {
                continue;
            }

            const pnl = position.transaction_type === 'BUY'
                ? (ltp - entryPrice) * quantity
                : (entryPrice - ltp) * quantity;

            if (totals.hasOwnProperty(position.account_id)) {
                totals[position.account_id] += pnl;
            }

            totals.total += pnl;
        }

        res.json(totals);
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get('/positions', async (req, res) => {
    try {
        const requestedAccount = req.query.account;
        const todayOnly = String(req.query.today || '').toLowerCase() === 'true';

        const whereClauses = [];
        const params = [];

        if (requestedAccount) {
            params.push(requestedAccount);
            whereClauses.push(`account_id = $${params.length}`);
        }

        if (todayOnly) {
            whereClauses.push(`created_at::date = CURRENT_DATE`);
        }

        const filter = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            ${filter}
            ORDER BY id DESC
            `,
            params
        );

        res.json(result.rows);
    } catch (err) {
        console.error('/positions error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.get("/positions/pnl", async (req, res) => {
    try {
        const positions = await positionService.getOpenPositions();

        const enriched = await Promise.all(
            positions.map(async (position) => {
                const trading_symbol = position.tradingsymbol || position.trading_symbol || position.symbol || "-";
                const exchange = position.exchange || position.exch || "NSE";
                const quantity = Number(position.quantity ?? position.net_quantity ?? position.qty ?? 0);
                const average_price = Number(position.average_price ?? position.entry_price ?? position.averagePrice ?? position.avg_price ?? 0);

                const priceInfo = await marketDataService.getPrice(`${exchange}:${trading_symbol}`) || await marketDataService.getPrice(trading_symbol);
                const ltp = priceInfo?.ltp ?? null;
                const pnl = ltp !== null && Number.isFinite(average_price) && average_price > 0
                    ? Number(quantity) * (ltp - average_price)
                    : null;

                return {
                    ...position,
                    ltp,
                    pnl
                };
            })
        );

        res.json(enriched);

    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// FETCH OPEN POSITIONS FROM BROKER - NOT FROM DATABASE
app.get("/positions/open", async (req, res) => {
    try {
        const requestedAccount = req.query.account;
        const targetAccounts = requestedAccount
            ? ACCOUNTS.filter(a => a.id === requestedAccount)
            : ACCOUNTS;

        if (requestedAccount && targetAccounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: `Unknown account: ${requestedAccount}`
            });
        }

        const allPositions = [];

        for (const account of targetAccounts) {
            try {
                const kc = await kite.getInstance(account.id);
                const positions = await kc.getPositions();

                const dayPositions = (positions.day || [])
                    .map(pos => ({
                        ...pos,
                        account_id: account.id,
                        source: "broker"
                    }));

                allPositions.push(...dayPositions);
            } catch (accountError) {
                console.error(
                    `❌ Failed to fetch positions for account ${account.id}`,
                    accountError.message
                );
            }
        }

        // Enrich positions with live LTP and PnL from market data service
        const enriched = await Promise.all(
            allPositions.map(async (position) => {
                const trading_symbol = position.tradingsymbol || position.trading_symbol || position.symbol || "-";
                const exchange = position.exchange || position.exch || "NSE";
                const quantity = Number(position.quantity ?? position.net_quantity ?? position.qty ?? 0);
                const average_price = Number(position.average_price ?? position.entry_price ?? position.averagePrice ?? position.avg_price ?? 0);

                const priceInfo = await marketDataService.getPrice(`${exchange}:${trading_symbol}`) 
                    || await marketDataService.getPrice(trading_symbol);
                
                const ltp = priceInfo?.ltp ?? position.last_price ?? null;
                const pnl = ltp !== null && Number.isFinite(average_price) && average_price > 0
                    ? Number(quantity) * (ltp - average_price)
                    : null;

                return {
                    ...position,
                    ltp,
                    pnl,
                    source: "broker"
                };
            })
        );

        res.json(enriched);

    } catch (err) {
        console.error('/positions/open error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

app.post('/angel/sync-instruments', async (req, res) => {

    try {

        await angelInstrumentService.runSync();

        res.json({
            success: true,
            message: 'Angel instrument sync completed'
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});
app.get('/health/angel', (req, res) => {
    res.json({
        success: true,
        ...angelWebSocketService.getHealthStatus(),
        service: 'angel-websocket'
    });
});
app.get("/favicon.ico", (req, res) => {
    res.sendFile(path.resolve("./favicon.ico"));
});

const server = http.createServer(app);

// INIT SOCKET
initSocket(server);

let runtimeRecoveryTimer = null;
let runtimeRecoveryInFlight = false;
let isShuttingDown = false;

async function initializeAngelRuntime() {
    try {
        console.log('🔐 Generating initial Angel session...');
        await angelAuthService.generateSession();
        console.log('✅ Angel session generated');
        await angelWebSocketService.start();
        console.log('📡 Angel WebSocket started');
    } catch (err) {
        console.error('❌ Failed to initialize Angel services:', err.message);
    }
}

function scheduleRuntimeRecovery() {
    if (runtimeRecoveryInFlight || runtimeRecoveryTimer) {
        return;
    }

    runtimeRecoveryTimer = setTimeout(async () => {
        runtimeRecoveryTimer = null;
        runtimeRecoveryInFlight = true;

        try {
            if (!angelWebSocketService.isConnected) {
                console.warn('⚠️ Angel WebSocket health check detected disconnect; recovering runtime...');
                await angelWebSocketService.restart();
            }
        } catch (err) {
            console.error('❌ Runtime recovery failed:', err?.message || err);
        } finally {
            runtimeRecoveryInFlight = false;
        }
    }, 10000);
}

function startServerLoop() {
    if (isShuttingDown) {
        return;
    }

    server.on('close', () => {
        if (isShuttingDown) {
            return;
        }

        console.warn('⚠️ HTTP server closed unexpectedly; restarting server loop...');
        setTimeout(() => {
            startServerLoop();
        }, 3000);
    });

    server.listen(3000, async () => {
        console.log('🚀 Server running on port 3000');
        await initializeAngelRuntime();
        setInterval(() => {
            if (!angelWebSocketService.isConnected) {
                scheduleRuntimeRecovery();
            }
        }, 15000);
    });
}

startServerLoop();


async function shutdown(signal) {
    isShuttingDown = true;

    console.log(
        `\n🛑 ${signal} received. Shutting down...`
    );

    try {

        await stopStockSymbolFillerJob();

    } catch (err) {

        console.error(
            'Error stopping Stock Symbol Filler:',
            err.message
        );
    }

    try {

        if (angelWebSocketService.stop) {

            await angelWebSocketService.stop();
        }

    } catch (err) {

        console.error(
            'Error stopping Angel WebSocket:',
            err.message
        );
    }

    server.close(() => {

        console.log(
            '✅ HTTP server closed'
        );

        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {

        console.error(
            '⚠️ Forced shutdown'
        );

        process.exit(1);

    }, 10000);
}

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);

process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);
