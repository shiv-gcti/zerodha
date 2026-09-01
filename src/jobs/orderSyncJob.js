import cron from 'node-cron';
import kite from '../config/kite.js';
import positionService from '../services/positionService.js';
import { ACCOUNTS } from '../config/accounts.js';
import { getIO } from '../socket/socketServer.js';
import tpSlService from '../services/tpSlService.js';

async function syncOrders() {

        for (const account of ACCOUNTS) {

        try {

            const kc = await kite.getInstance(account.id);
            const orders = await kc.getOrders();

            for (const order of orders) {
                const payload = {
                    ...order,
                    account_id: account.id,
                    timestamp: new Date().toISOString()
                };

                try {
                    const io = getIO();
                    io.emit('order:update', payload);
                    io.emit('order', payload);
                } catch (socketError) {
                    console.warn('Order sync socket emit skipped - socket unavailable', socketError?.message || socketError);
                }

                await tpSlService.handleOrderUpdate(account.id, payload);
            }

            // ==============================
            // STEP 1: GET OPEN POSITIONS
            // ==============================
            const openPositions =
                await positionService.getOpenPositionsByAccount(account.id);

            // ==============================
            // STEP 2: UPDATE ENTRY PRICE
            // ==============================
            for (const position of openPositions) {

                if (!position.entry_order_id) continue;

                const order = orders.find(
                    o => o.order_id === position.entry_order_id
                );

                if (!order) continue;

                if (
                    order.status === 'COMPLETE' &&
                    !position.entry_price
                ) {

                    await positionService.updateEntryPrice(
                        order.order_id,
                        Number(order.average_price || 0)
                    );

                    console.log(
                        `✅ Entry updated: ${position.tradingsymbol}`
                    );
                }
            }

            // ==============================
            // STEP 3: CREATE MISSING POSITIONS
            // ==============================
            const completedOrders = orders.filter(
                o => o.status === 'COMPLETE'
            );

            for (const order of completedOrders) {

                const exists = await positionService.getByAnyOrderId(order.order_id, account.id);

                if (!exists) {

                    await positionService.create(
                        {
                            accountId: account.id,
                            tradingsymbol: order.tradingsymbol,
                            exchange: order.exchange,
                            transaction_type: order.transaction_type,
                            product: order.product || 'CNC',
                            quantity: order.quantity,
                            targetPoints: null,
                            stopLossPoints: null
                        },
                        order.order_id
                    );

                    console.log(
                        `📌 Position created: ${order.tradingsymbol}`
                    );
                }
            }

        } catch (error) {
            const message = error?.message || String(error);
            if (/No token found for account/i.test(message)) {
                console.warn(`[ORDER_SYNC_SKIP] ${account.id}: no valid Zerodha token yet. Run /zerodha/kite/login?account=${account.id} to authenticate.`);
                continue;
            }

            console.error(
                `❌ Order Sync Failed (${account.id})`,
                message
            );
        }
    }

    }

export function startOrderSyncJob() {
    cron.schedule('*/30 * * * * *', syncOrders);
    console.log('📅 Order Sync Job scheduled every 30 seconds');
}
