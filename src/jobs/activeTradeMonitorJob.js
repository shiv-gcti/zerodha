import cron from 'node-cron';
import { ACCOUNTS } from '../config/accounts.js';
import kite from '../config/kite.js';
import positionService from '../services/positionService.js';
import tpSlService from '../services/tpSlService.js';

async function monitorActiveTrades() {
    const now = Date.now();
    const lastErrorByAccount = new Map();

    for (const account of ACCOUNTS) {
        try {
            const activeTrades = await positionService.getLifecycleActiveByAccount(account.id);
            if (!activeTrades.length) continue;

            const kc = await kite.getInstance(account.id);
            const orders = await kc.getOrders();

            for (const trade of activeTrades) {
                const ids = [
                    trade.entry_order_id,
                    trade.target_order_id,
                    trade.stoploss_order_id
                ].filter(Boolean);

                for (const orderId of ids) {
                    const order = orders.find(o => o.order_id === orderId);
                    if (!order) continue;

                    await tpSlService.handleOrderUpdate(account.id, {
                        ...order,
                        account_id: account.id,
                        source: 'rest_fallback'
                    });
                }
            }
        } catch (error) {
            const previous = lastErrorByAccount.get(account.id) || 0;
            if (now - previous > 15000) {
                console.error(`[FALLBACK] Active trade monitor failed for ${account.id}`, error?.message || error);
                lastErrorByAccount.set(account.id, now);
            }
        }
    }
}

export function startActiveTradeMonitorJob() {
    cron.schedule('*/2 * * * * *', monitorActiveTrades);
    console.log('[FALLBACK] Active trade monitor scheduled every 2 seconds');
}
