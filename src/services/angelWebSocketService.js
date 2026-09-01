import {
    SmartAPI,
    WebSocketV2
} from "smartapi-javascript";

import fs from 'fs';
import path from 'path';
import db from "./dbService.js";

const DATA_DIR = path.resolve(process.cwd(), 'data', 'local-store');
fs.mkdirSync(DATA_DIR, { recursive: true });

function readTable(tableName) {
    const filePath = path.join(DATA_DIR, `${tableName}.json`);
    if (!fs.existsSync(filePath)) return [];
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

class angelWebSocketService {

    constructor() {

        this.smartApi = null;
        this.ws = null;

        this.isConnected = false;
        this.updateInterval = null;
        this.reconnectTimer = null;
        this.restartAttempts = 0;
        this.maxRestartDelayMs = 30000;
        this.lastTickAt = null;

        this.tokens = [];

        // symbol_token -> { ltp, ts }
        this.ltpMap = new Map();
    }

    // =========================
    // START SERVICE
    // =========================
    scheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }

        const delayMs = Math.min(2000 + (this.restartAttempts * 2000), this.maxRestartDelayMs);
        this.restartAttempts += 1;

        console.warn(`⚠️ Angel WebSocket disconnected; scheduling reconnect in ${delayMs}ms`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.restart();
            } catch (err) {
                console.error('❌ Automatic Angel reconnect failed:', err?.message || err);
                this.scheduleReconnect();
            }
        }, delayMs);
    }

    attachSocketLifecycleHandlers() {
        if (!this.ws) {
            return;
        }

        this.ws.on('close', () => {
            this.isConnected = false;
            console.warn('⚠️ Angel WebSocket closed unexpectedly');
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            this.isConnected = false;
            console.error('❌ Angel WebSocket error:', err?.message || err);
            this.scheduleReconnect();
        });
    }

    async start() {

        try {

            console.log(
                "🚀 Starting Angel WebSocket Service..."
            );

            const tokenRow =
                await this.getLatestToken();

            if (!tokenRow) {

                throw new Error(
                    "No Angel token found"
                );
            }

            this.smartApi =
                new SmartAPI({
                    api_key:
                        process.env.ANGEL_API_KEY
                });

            await this.loadTokens();

            if (
                this.tokens.length === 0
            ) {

                console.log(
                    "⚠️ No symbol tokens found"
                );

                return;
            }

            await this.connectWebSocket(
                tokenRow
            );

            this.startDbSync();

        } catch (err) {

            console.error(
                "❌ WebSocket start failed:",
                err.message
            );
        }
    }

    // =========================
    // LOAD TOKENS
    // =========================
    async loadTokens() {

        console.log(
            "📡 Loading symbol tokens..."
        );

        const result =
            await db.query(`
                SELECT
                    instrument_token AS symbol_token,
                    exchange
                FROM zerodha_instruments
                WHERE instrument_token IS NOT NULL
                ORDER BY updated_at DESC
                LIMIT 5000
            `);

        this.tokens =
            result.rows
                .filter(row => Number.isFinite(Number(row.symbol_token)))
                .map(row => ({
                    token:
                        Number(
                            row.symbol_token
                        ),
                    exchangeType:
                        this.mapExchange(
                            row.exchange
                        )
                }));

        if (this.tokens.length === 0) {
            const fallbackResult = await db.query(`
                SELECT
                    symbol_token,
                    exch_seg AS exchange
                FROM angel_instruments
                WHERE symbol_token IS NOT NULL
                ORDER BY updated_at DESC
                LIMIT 2000
            `);

            this.tokens = fallbackResult.rows
                .filter(row => Number.isFinite(Number(row.symbol_token)))
                .map(row => ({
                    token: Number(row.symbol_token),
                    exchangeType: this.mapExchange(row.exchange)
                }));
        }

        console.log(
            `✅ Loaded ${this.tokens.length} tokens`
        );
    }

    // =========================
    // EXCHANGE MAP
    // =========================
    mapExchange(exchange) {

        switch (
            String(exchange)
                .toUpperCase()
        ) {

            case "NSE":
                return 1;

            case "NFO":
                return 2;

            case "MCX":
                return 5;

            case "CDS":
                return 7;

            default:
                return 1;
        }
    }

    // =========================
    // CONNECT WS
    // =========================
    async connectWebSocket(
        tokenRow
    ) {

        console.log(
            "🔌 Connecting Angel WebSocket..."
        );

        this.ws =
            new WebSocketV2({

                jwttoken:
                    tokenRow.jwt_token,

                apikey:
                    process.env.ANGEL_API_KEY,

                clientcode:
                    process.env
                        .ANGEL_CLIENT_CODE,

                feedtype:
                    tokenRow.feed_token
            });

        // Auto reconnect
        this.ws.reconnection(
            "simple",
            5000
        );

        // Tick handler
this.ws.on(
    "tick",
    ticks => {

        this.handleTick(ticks);
    }
);

        // Connect
        await this.ws.connect();

        this.isConnected =
            true;
        this.restartAttempts = 0;

        this.attachSocketLifecycleHandlers();

        console.log(
            "🟢 Angel WebSocket Connected"
        );

        this.subscribeTokens();
    }

    // =========================
    // SUBSCRIBE
    // =========================
subscribeTokens() {

    console.log("📥 Subscribing tokens...");

    const grouped = {};

    for (const tokenObj of this.tokens) {

        if (!grouped[tokenObj.exchangeType]) {
            grouped[tokenObj.exchangeType] = [];
        }

        grouped[tokenObj.exchangeType].push(
            String(tokenObj.token)
        );
    }

    for (const [exchangeType, tokens] of Object.entries(grouped)) {

        const payload = {

            correlationID: `sub_${exchangeType}`,

            action: 1,

            mode: 1,

            exchangeType: Number(exchangeType),

            tokens
        };

        this.ws.fetchData(payload);

        console.log(
            `📡 Subscribed ${tokens.length} tokens on exchange ${exchangeType}`
        );
    }
}

    // =========================
    // HANDLE TICKS
    // =========================
    handleTick(ticks) {

        try {

            const tickArray =
                Array.isArray(
                    ticks
                )
                    ? ticks
                    : [ticks];

            for (
                const tick
                of tickArray
            ) {

const token =
    Number(
        String(tick.token)
            .replace(/"/g, '')
            .trim()
    );

const ltp =
    Number(
        tick.last_traded_price
    ) / 100;

                if (

                    Number.isFinite(
                        token
                    ) &&

                    Number.isFinite(
                        ltp
                    )
                ) {

                    const timestamp = Date.now();
                    this.lastTickAt = timestamp;
                    this.ltpMap.set(
                        token,
                        {
                            ltp,
                            ts: timestamp
                        }
                    );

                }
            }

        } catch (err) {

            console.error(
                "❌ Tick parse error:",
                err.message
            );
        }
    }

    // =========================
    // DB SYNC
    // =========================
    startDbSync() {

        console.log(
            "⏱️ Starting DB sync (5 sec interval)"
        );

        this.updateInterval =
            setInterval(
                async () => {

                    await this.flushToDB();

                },
                5000
            );
    }

    // =========================
    // FLUSH TO DB
    // =========================
    async flushToDB() {

        if (
            this.ltpMap.size === 0
        ) {

            return;
        }

        const updates =
            Array.from(
                this.ltpMap.entries()
            );

        this.ltpMap.clear();

        try {

            for (
                const [
                    token,
                    data
                ]
                of updates
            ) {

                await db.query(
                    `
                    UPDATE stock_symbols
                    SET
                        ltp = $1,
                        ltp_updated_at = NOW()
                    WHERE symbol_token = $2
                    `,
                    [
                        data.ltp,
                        token
                    ]
                );
            }

            console.log(
                `⚡ Updated LTP for ${updates.length} symbols`
            );

        } catch (err) {

            console.error(
                "❌ DB update error:",
                err.message
            );
        }
    }

    // =========================
    // GET TOKEN
    // =========================
    getHealthStatus() {
        return {
            connected: Boolean(this.isConnected),
            reconnectAttempts: Number(this.restartAttempts || 0),
            lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
            tokensLoaded: Array.isArray(this.tokens) ? this.tokens.length : 0,
            updatedAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null
        };
    }

    async getLatestToken() {
        const rows = readTable('angel_tokens').sort((a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0));
        return rows[0] || null;
    }

async restart() {

    console.log(
        "🔄 Restarting Angel WebSocket..."
    );

    this.stop();

    // wait 2 sec
    await new Promise(resolve =>
        setTimeout(resolve, 2000)
    );

    await this.start();

    console.log(
        "✅ Angel WebSocket restarted"
    );
}

    // =========================
    // STOP
    // =========================
    stop() {

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (
            this.ws
        ) {

            try {
                this.ws.close();
            } catch (err) {
                console.warn('⚠️ Non-fatal Angel WS close warning:', err?.message || err);
            }
        }

        if (
            this.updateInterval
        ) {

            clearInterval(
                this.updateInterval
            );
        }

        this.isConnected =
            false;

        console.log(
            "🛑 Angel WebSocket stopped"
        );
    }
}

export default new angelWebSocketService();

