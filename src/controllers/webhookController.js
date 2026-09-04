import {
    buildOrderPayload,
    placeOrder,
    checkAndHandleReversal
} from '../services/orderService.js';

import { getIO } from '../socket/socketServer.js';
import duplicateSignalService from '../services/duplicateSignalService.js';
import tradeLifecycleService from '../services/tradeLifecycleService.js';

function classifyWebhookError(error) {
    const message = String(error?.message || error);

    if (/Maximum allowed order requests exceeded|allowed order requests exceeded|rate.?limit|throttle/i.test(message)) {
        return {
            status: 200,
            message,
            retryAfterSeconds: 45
        };
    }

    if (/is required|Invalid account|Instrument not found/i.test(message)) {
        return {
            status: 400,
            message
        };
    }

    return {
        status: 500,
        message
    };
}

export const receiveSignal = async (req, res) => {

    try {

        if (!req.body) {
            return res.status(400).json({
                success: false,
                message: 'Missing JSON body'
            });
        }

        console.log('BODY:', JSON.stringify(req.body, null, 2));

        const signal = Array.isArray(req.body) ? req.body[0] : req.body;
        const accountId = signal.AC || signal.account || 'UNKNOWN';

        const signalLifecycle = await tradeLifecycleService.createSignalLifecycle(signal, accountId);
        signal.signalId = signalLifecycle.signalId;

        console.log('SIGNAL:', signal);

        // ============================
        // 🔍 DUPLICATE SIGNAL CHECK (45-second window)
        // ============================
        const isDuplicate = await duplicateSignalService.isDuplicateSignal(signal);
        if (isDuplicate) {
            console.log('🚫 DUPLICATE SIGNAL DETECTED - Skipping order placement');
            console.log('Signal:', signal);

            // Try to emit via socket
            try {
                const io = getIO();
                const duplicatePayload = {
                    ...signal,
                    receivedAt: new Date().toISOString(),
                    status: 'duplicate',
                    message: 'Duplicate signal detected within 45-second window - skipped'
                };
                io.emit("signal:duplicate", duplicatePayload);
            } catch (socketErr) {
                console.error("Socket emit failed:", socketErr.message);
            }

            return res.status(200).json({
                success: false,
                message: 'Duplicate signal detected within 45-second window - order placement skipped',
                duplicate: true,
                signal
            });
        }

        // Mark this signal as received for the next 45 seconds
        await duplicateSignalService.markSignalAsReceived(signal, 45);

        // ============================
        // 🔄 SIGNAL REVERSAL CHECK
        // ============================
        const reversalResult = await checkAndHandleReversal(signal, accountId);
        
        if (reversalResult) {
            console.log('✅ Signal reversal handled - Position closed and ready for new order');
            console.log(`[REVERSAL] Applied defaults - TP: ${reversalResult.tpslInfo?.targetPoints}, SL: ${reversalResult.tpslInfo?.stopLossPoints}`);
            
            // Use signal with defaults for new order
            Object.assign(signal, reversalResult.signal);
            
            // Emit reversal event
            try {
                const io = getIO();
                io.emit("signal:reversal", {
                    ...reversalResult,
                    receivedAt: new Date().toISOString()
                });
            } catch (socketErr) {
                console.error("Socket emit failed for reversal:", socketErr.message);
            }
        }

        // ============================

        const orderPayload = await buildOrderPayload(signal);

        console.log('ORDER PAYLOAD:', orderPayload);

        // Try placing order; if blocked due to broker/order cooldown, retry a few times with backoff
        let result = await placeOrder(orderPayload);
        let attempt = 1;
        while (result && result.blocked && result.cooldown && attempt <= 3) {
            const delayMs = 1000 * attempt; // 1s, 2s, 3s
            console.log(`[RETRY] Order placement blocked by cooldown, retrying in ${delayMs}ms (attempt ${attempt})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            result = await placeOrder(orderPayload);
            attempt += 1;
        }

        // ============================
        // 🔥 REAL-TIME SOCKET PUSH
        // ============================
        try {
            const io = getIO();
            const signalPayload = { ...signal, receivedAt: new Date().toISOString() };
            const orderPayload = {
                signal,
                result,
                timestamp: new Date().toISOString()
            };

            io.emit("signal:new", signalPayload);
            io.emit("signal", signalPayload); // fallback compatibility

            io.emit("order:new", orderPayload);
            io.emit("order", orderPayload); // fallback compatibility

        } catch (socketErr) {
            console.error("Socket emit failed:", socketErr.message);
        }

        // ============================

        res.json({
            success: true,
            result
        });

    } catch (error) {

        console.error('[WEBHOOK_ORDER_FAILED]', {
            message: error?.message || String(error),
            stack: error?.stack,
            signal: req.body
        });

        const classified = classifyWebhookError(error);

        res.status(classified.status).json({
            success: false,
            message: classified.message,
            retryAfterSeconds: classified.retryAfterSeconds
        });
    }
};
