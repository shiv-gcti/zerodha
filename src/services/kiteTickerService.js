import { KiteTicker } from 'kiteconnect';
import { ACCOUNTS } from '../config/accounts.js';
import tokenManager from './tokenManager.js';
import tpSlService from './tpSlService.js';
import { getIO } from '../socket/socketServer.js';

class KiteTickerService {
    constructor() {
        this.tickers = new Map();
        this.activeAccountId = null;
        this.tokenUpdatedAtByAccount = new Map();
        this.pendingReconnectAccountIds = new Set();
        this.authRejectedAccountIds = new Set();
        this.startingAccountIds = new Set();
        this.tokenMonitorTimer = null;
    }

    async start() {
        console.warn('[WS] Startup websocket disabled; ticker starts only after an order is placed');
        this.startTokenMonitor();
    }

    async startForAccountId(accountId) {
        if (String(process.env.KITE_WS_ENABLED || 'true').toLowerCase() === 'false') {
            console.warn('[WS] Kite websocket disabled by KITE_WS_ENABLED=false; REST fallback remains active');
            return;
        }

        const account = ACCOUNTS.find(a => a.id === accountId);
        if (!account) {
            console.warn(`[WS] Account not found for websocket: ${accountId}`);
            return;
        }

        await this.startForAccount(account);
    }

    async startForAccount(account) {
        if (this.activeAccountId === account.id && this.tickers.has(account.id)) return;

        if (this.startingAccountIds.has(account.id)) return;
        this.startingAccountIds.add(account.id);

        try {
            await this.startForAccountInternal(account);
        } finally {
            this.startingAccountIds.delete(account.id);
        }
    }

    async startForAccountInternal(account) {

        this.startTokenMonitor();
        await this.stopActiveTicker(account.id);

        if (!account.apiKey) {
            console.warn(`[WS] Skipping ${account.id}; API key missing`);
            return;
        }

        const tokenRecord = await tokenManager.getTokenRecord(account.id);
        if (!tokenRecord?.access_token) {
            console.warn(`[WS] Skipping ${account.id}; access token missing`);
            return;
        }
        this.tokenUpdatedAtByAccount.set(account.id, tokenRecord.updated_at || null);
        this.pendingReconnectAccountIds.delete(account.id);
        this.authRejectedAccountIds.delete(account.id);

        const ticker = new KiteTicker({
            api_key: account.apiKey,
            access_token: tokenRecord.access_token,
            reconnect: false
        });

        ticker.on('connect', () => {
            console.log(`[WS] Connected for ${account.id}`);
        });

        ticker.on('disconnect', (error) => {
            console.warn(`[WS] Disconnected for ${account.id}`, error?.message || '');
        });

        ticker.on('error', (error) => {
            const message = error?.message || String(error);
            if (message.includes('403')) {
                console.warn(`[WS] Zerodha rejected websocket auth for ${account.id} (403). REST fallback remains active.`);
                this.handleAuthReject(account, ticker);
                return;
            }

            console.warn(`[WS] Error for ${account.id}`, message);
        });

        ticker.on('order_update', async (order) => {
            const payload = {
                ...order,
                account_id: account.id,
                timestamp: new Date().toISOString(),
                source: 'kite_ws'
            };

            try {
                getIO().emit('order:update', payload);
                getIO().emit('order', payload);
            } catch {
                // Socket.IO is only for dashboard clients; TP/SL still proceeds.
            }

            await tpSlService.handleOrderUpdate(account.id, payload);
        });

        ticker.connect();
        this.tickers.set(account.id, ticker);
        this.activeAccountId = account.id;
        console.log(`[WS] Kite ticker starting for ${account.id}`);
    }

    async handleAuthReject(account, ticker) {
        try {
            ticker.disconnect();
        } catch {
            // Already disconnected.
        }

        this.tickers.delete(account.id);
        if (this.activeAccountId === account.id) {
            this.activeAccountId = null;
        }
        this.pendingReconnectAccountIds.add(account.id);
        this.authRejectedAccountIds.add(account.id);
        console.warn(`[WS] ${account.id} ticker disabled until Zerodha token changes; REST fallback remains active.`);
    }

    startTokenMonitor() {
        if (this.tokenMonitorTimer) return;

        const intervalMs = Number(process.env.KITE_TOKEN_MONITOR_INTERVAL_MS || 15000);
        this.tokenMonitorTimer = setInterval(async () => {
            await this.checkActiveToken();
        }, intervalMs);

        if (typeof this.tokenMonitorTimer.unref === 'function') {
            this.tokenMonitorTimer.unref();
        }

        console.log(`[WS] Token monitor active every ${intervalMs}ms`);
    }

    async checkActiveToken() {
        if (this.activeAccountId) {
            await this.refreshTickerIfTokenChanged(this.activeAccountId);
        }

        for (const accountId of [...this.pendingReconnectAccountIds]) {
            await this.refreshTickerIfTokenChanged(accountId);
        }
    }

    async refreshTickerIfTokenChanged(accountId, forceLog = false) {
        const account = ACCOUNTS.find(a => a.id === accountId);
        if (!account) return;

        const tokenRecord = await tokenManager.getTokenRecord(accountId);
        const latestUpdatedAt = tokenRecord?.updated_at || null;
        const hasPreviousTokenSnapshot = this.tokenUpdatedAtByAccount.has(accountId);
        const previousUpdatedAt = this.tokenUpdatedAtByAccount.get(accountId) || null;

        if (!tokenRecord?.access_token) {
            if (forceLog) console.warn(`[WS] Token refresh check found no token for ${accountId}`);
            return;
        }

        if (this.authRejectedAccountIds.has(accountId) && latestUpdatedAt === previousUpdatedAt) {
            return;
        }

        if (!hasPreviousTokenSnapshot || latestUpdatedAt !== previousUpdatedAt) {
            console.log(`[WS] Fresh Zerodha token detected for ${accountId}; reconnecting ticker`);
            this.tokenUpdatedAtByAccount.set(accountId, latestUpdatedAt);
            await this.stopTickerForAccount(accountId);
            this.pendingReconnectAccountIds.delete(accountId);
            await this.startForAccount(account);
        } else if (forceLog) {
            console.warn(`[WS] Token for ${accountId} has not changed yet; waiting for zerodha_tokens.updated_at before reconnect`);
        }
    }

    async stopActiveTicker(nextAccountId = null) {
        if (!this.activeAccountId || this.activeAccountId === nextAccountId) return;

        await this.stopTickerForAccount(this.activeAccountId);
    }

    async stopTickerForAccount(accountId) {
        const ticker = this.tickers.get(accountId);
        if (ticker) {
            try {
                ticker.disconnect();
                console.log(`[WS] Stopped Kite ticker for ${accountId}`);
            } catch (error) {
                console.warn(`[WS] Failed to stop ticker for ${accountId}`, error?.message || error);
            }
        }

        this.tickers.delete(accountId);
        if (this.activeAccountId === accountId) {
            this.activeAccountId = null;
        }
    }
}

export default new KiteTickerService();
