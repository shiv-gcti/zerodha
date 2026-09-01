import kite from '../config/kite.js';
import positionService from './positionService.js';
import tradeLifecycleService from './tradeLifecycleService.js';
import { getIO } from '../socket/socketServer.js';

const ACTIVE_STATUSES = new Set([
    'ENTRY_PENDING',
    'ENTRY_FILLED',
    'TARGET_PLACED',
    'STOPLOSS_PLACED',
    'GTT_OCO_PLACED',
    'ACTIVE'
]);

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function hasPositivePoints(value) {
    const num = toNumber(value);
    return num !== null && num > 0;
}

function envFlag(name, defaultValue = true) {
    const value = process.env[name];
    if (value === undefined || value === '') return defaultValue;
    return String(value).toLowerCase() === 'true';
}

function isComplete(order) {
    return String(order?.status || '').toUpperCase() === 'COMPLETE';
}

function isRejected(order) {
    const status = String(order?.status || '').toUpperCase();
    return status === 'REJECTED' || status === 'CANCELLED';
}

function oppositeTransactionType(transactionType) {
    return String(transactionType).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
}

function roundPrice(price) {
    return Math.round(Number(price) * 100) / 100;
}

function calculateExitPrices(position, entryPrice) {
    const side = String(position.transaction_type || '').toUpperCase();
    const targetPoints = toNumber(position.target_points);
    const stopLossPoints = toNumber(position.stoploss_points);

    const targetPrice = hasPositivePoints(targetPoints)
        ? roundPrice(side === 'BUY' ? entryPrice + targetPoints : entryPrice - targetPoints)
        : null;

    const stopLossPrice = hasPositivePoints(stopLossPoints)
        ? roundPrice(side === 'BUY' ? entryPrice - stopLossPoints : entryPrice + stopLossPoints)
        : null;

    return { targetPrice, stopLossPrice };
}

function extractOrderId(result) {
    if (!result) return null;
    if (typeof result === 'string' || typeof result === 'number') return String(result);
    return result.order_id || result.orderId || result.parent_order_id || null;
}

function extractTriggerId(result) {
    if (!result) return null;
    if (typeof result === 'string' || typeof result === 'number') return String(result);
    return result.trigger_id || result.triggerId || result.id || null;
}

function isOrderLimitMessage(message) {
    return /Maximum allowed order requests exceeded|allowed order requests exceeded|Kite order request cooldown active|rate.?limit|throttle/i.test(message);
}

function isManualExitRequired(position) {
    return String(position?.lifecycle_status || '').toUpperCase() === 'MANUAL_EXIT_REQUIRED';
}

function getOrderFilledQuantity(order) {
    const qty = order?.filled_quantity ?? order?.quantity ?? order?.qty ?? 0;
    return toNumber(qty) || 0;
}

function getOrderExecutionPrice(order) {
    return toNumber(order.average_price) || toNumber(order.price) || null;
}

class TpSlService {
    constructor() {
        this.exitPlacementInProgress = new Set();
        this.exitCooldownUntilByPositionId = new Map();
    }

    async initialize() {
        await tradeLifecycleService.ensureSchema();
    }

    async registerEntry(position) {
        await this.initialize();

        const managed = hasPositivePoints(position.target_points) || hasPositivePoints(position.stoploss_points);
        const status = managed ? 'ENTRY_PENDING' : 'ENTRY_FILLED';

        await positionService.updateLifecycle(position.id, {
            managed,
            lifecycleStatus: managed ? 'ENTRY_PENDING' : 'ACTIVE'
        });

        await tradeLifecycleService.record(
            position,
            managed ? 'ENTRY_PENDING' : 'UNMANAGED',
            {
                entryOrderId: position.entry_order_id,
                targetPoints: position.target_points,
                stopLossPoints: position.stoploss_points
            },
            position.entry_order_id
        );

        console.log(managed
            ? `[ENTRY] Tracking managed trade ${position.id} order ${position.entry_order_id}`
            : `[TRADE] Unmanaged trade ${position.id}; no TP/SL provided`);

        return status;
    }

    async handleOrderUpdate(accountId, order) {
        await this.initialize();

        if (!order?.order_id) return;

        let position = await positionService.getByAnyOrderId(order.order_id, accountId);
        if (!position) {
            // Try to find an exit that matches this order (OCO leg hit)
            position = await this.findUntrackedExitPosition(accountId, order);
            if (position) {
                await this.handleUntrackedExitUpdate(position, order);
                return;
            }

            // If not an exit, try to match this as an untracked entry (order executed in broker terminal)
            position = await this.findUntrackedEntryPosition(accountId, order);
            if (position) {
                await this.handleUntrackedEntryUpdate(position, order);
                return;
            }
            return;
        }
        if (!position) return;

        if (order.order_id === position.entry_order_id) {
            await this.handleEntryUpdate(position, order);
            return;
        }

        if (order.order_id === position.target_order_id) {
            await this.handleExitUpdate(position, order, 'TARGET');
            return;
        }

        if (order.order_id === position.stoploss_order_id) {
            await this.handleExitUpdate(position, order, 'STOPLOSS');
        }
    }

    async handleEntryUpdate(position, order) {
        if (isRejected(order)) {
            await positionService.updateLifecycle(position.id, {
                lifecycleStatus: 'REJECTED',
                lastError: order.status_message || order.status || 'Entry order rejected'
            });

            await tradeLifecycleService.record(position, 'ENTRY_REJECTED', order, order.order_id);
            console.log(`[ENTRY] Order rejected ${order.order_id}`);
            return;
        }

        if (!isComplete(order)) return;

        if (!position.managed) {
            const entryPrice = toNumber(order.average_price);
            if (entryPrice !== null && !position.entry_price) {
                await positionService.updateEntryPrice(order.order_id, entryPrice);
            }
            return;
        }

        if (!ACTIVE_STATUSES.has(position.lifecycle_status)) return;

        const averagePrice = toNumber(order.average_price);
        if (averagePrice === null || averagePrice <= 0) {
            console.log(`[ENTRY] Complete update missing average price for ${order.order_id}`);
            return;
        }

        await positionService.updateEntryPrice(order.order_id, averagePrice);
        await positionService.updateLifecycle(position.id, {
            lifecycleStatus: 'ENTRY_FILLED'
        });
        await tradeLifecycleService.record(position, 'ENTRY_FILLED', order, order.order_id);

        console.log(`[ENTRY] Order executed ${order.order_id}`);
        console.log(`[ENTRY] Average price fetched ${averagePrice}`);

        const freshPosition = await positionService.getByOrderId(order.order_id);
        await this.placeExitOrders(freshPosition || { ...position, entry_price: averagePrice });
    }

    async placeExitOrders(position) {
        if (!position?.managed) return;

        if (!envFlag('ENABLE_AUTO_EXIT_ORDERS', true)) {
            console.log('[EXIT] Auto TP/SL order placement disabled by ENABLE_AUTO_EXIT_ORDERS=false');
            return;
        }

        if (this.exitCooldownUntilByPositionId?.has(position.id)) {
            const untilMs = this.exitCooldownUntilByPositionId.get(position.id);
            if (Number.isFinite(untilMs) && untilMs > Date.now()) return;
        }

        if (position.exit_place_cooldown_until) {
            const untilMs = new Date(position.exit_place_cooldown_until).getTime();
            if (Number.isFinite(untilMs) && untilMs > Date.now()) return;
        }

        if (position.target_order_id || position.stoploss_order_id) return;
        if (position.exit_gtt_id) return;
        if (isManualExitRequired(position)) return;
        if (!ACTIVE_STATUSES.has(position.lifecycle_status)) return;
        if (this.exitPlacementInProgress.has(position.id)) return;

        const entryPrice = toNumber(position.entry_price);
        if (entryPrice === null || entryPrice <= 0) return;

        this.exitPlacementInProgress.add(position.id);

        try {
            const { targetPrice, stopLossPrice } = calculateExitPrices(position, entryPrice);
            const exitSide = oppositeTransactionType(position.transaction_type);
            let status = position.lifecycle_status;
            const targetDefined = targetPrice !== null;
            const stopLossDefined = stopLossPrice !== null;

            if (targetDefined && stopLossDefined && this.shouldUseGttOco(position, targetPrice, stopLossPrice)) {
                const gttId = await this.placeGttOcoWithRetry(position, exitSide, targetPrice, stopLossPrice, entryPrice);

                if (gttId) {
                    await positionService.setExitGtt(position.id, gttId, targetPrice, stopLossPrice);
                    await tradeLifecycleService.record(position, 'GTT_OCO_PLACED', {
                        gttId,
                        targetPrice,
                        stopLossPrice
                    }, gttId);
                    console.log(`[GTT] CNC OCO placed ${gttId} target ${targetPrice} stop ${stopLossPrice}`);
                    status = 'GTT_OCO_PLACED';
                } else {
                    return;
                }

                await positionService.updateLifecycle(position.id, {
                    lifecycleStatus: status === 'ENTRY_FILLED' ? 'ACTIVE' : status
                });
                return;
            }

            if (targetPrice !== null && !position.target_order_id) {
                const targetOrderId = await this.placeWithRetry(position, 'TP', {
                    exchange: position.exchange,
                    tradingsymbol: position.tradingsymbol,
                    transaction_type: exitSide,
                    quantity: Number(position.quantity),
                    order_type: 'LIMIT',
                    product: position.product || 'CNC',
                    validity: 'DAY',
                    price: targetPrice
                });

                if (targetOrderId) {
                    await positionService.setTargetOrder(position.id, targetOrderId, targetPrice);
                    await tradeLifecycleService.record(position, 'TARGET_PLACED', { targetPrice }, targetOrderId);
                    console.log(`[TP] Target order placed ${targetOrderId} @ ${targetPrice}`);
                    status = 'TARGET_PLACED';
                } else {
                    return;
                }
            }

            const latest = await positionService.getById(position.id);
            const stopSource = latest || position;

            if (stopLossPrice !== null && !stopSource.stoploss_order_id) {
                const stopLossOrderId = await this.placeWithRetry(stopSource, 'SL', {
                    exchange: stopSource.exchange,
                    tradingsymbol: stopSource.tradingsymbol,
                    transaction_type: exitSide,
                    quantity: Number(stopSource.quantity),
                    order_type: 'SL-M',
                    product: stopSource.product || 'CNC',
                    validity: 'DAY',
                    trigger_price: stopLossPrice
                });

                if (stopLossOrderId) {
                    await positionService.setStopLossOrder(stopSource.id, stopLossOrderId, stopLossPrice);
                    await tradeLifecycleService.record(stopSource, 'STOPLOSS_PLACED', { stopLossPrice }, stopLossOrderId);
                    console.log(`[SL] Stop loss order placed ${stopLossOrderId} @ ${stopLossPrice}`);
                    status = status === 'TARGET_PLACED' ? 'ACTIVE' : 'STOPLOSS_PLACED';
                } else {
                    return;
                }
            }

            await positionService.updateLifecycle(position.id, {
                lifecycleStatus: status === 'ENTRY_FILLED' ? 'ACTIVE' : status
            });
        } finally {
            this.exitPlacementInProgress.delete(position.id);
        }
    }

    shouldUseGttOco(position, targetPrice, stopLossPrice) {
        const product = String(position.product || 'CNC').toUpperCase();
        return product === 'CNC' && targetPrice !== null && stopLossPrice !== null;
    }

    async placeGttOco(position, exitSide, targetPrice, stopLossPrice, entryPrice) {
        const lastPrice = await this.getGttLastPrice(position, entryPrice);
        const gttPayload = {
            trigger_type: 'two-leg',
            exchange: position.exchange,
            tradingsymbol: position.tradingsymbol,
            trigger_values: [stopLossPrice, targetPrice],
            last_price: lastPrice,
            orders: [
                {
                    transaction_type: exitSide,
                    quantity: Number(position.quantity),
                    order_type: 'LIMIT',
                    product: 'CNC',
                    price: stopLossPrice
                },
                {
                    transaction_type: exitSide,
                    quantity: Number(position.quantity),
                    order_type: 'LIMIT',
                    product: 'CNC',
                    price: targetPrice
                }
            ]
        };

        return extractTriggerId(await kite.placeGTT(gttPayload, position.account_id));
    }

    async placeGttOcoWithRetry(position, exitSide, targetPrice, stopLossPrice, entryPrice, attempts = 2) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await this.placeGttOco(position, exitSide, targetPrice, stopLossPrice, entryPrice);
            } catch (error) {
                const message = error?.message || String(error);
                console.error(`[GTT] OCO placement failed attempt ${attempt}: ${message}`);
                await positionService.updateLifecycle(position.id, {
                    lastError: `[GTT] ${message}`
                });

                if (attempt === attempts) {
                    await this.markManualExitRequired(position, {
                        label: 'GTT',
                        message,
                        attempts,
                        targetPrice,
                        stopLossPrice
                    });
                    return null;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return null;
    }

    async getGttLastPrice(position, fallbackPrice) {
        try {
            return await kite.getLTP(position.account_id, position.exchange, position.tradingsymbol) || fallbackPrice;
        } catch (error) {
            console.warn(`[GTT] LTP fetch failed for ${position.tradingsymbol}; using entry price`, error?.message || error);
            return fallbackPrice;
        }
    }

    async placeWithRetry(position, label, orderPayload, attempts = 2) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return extractOrderId(await kite.placeOrder(orderPayload, position.account_id));
            } catch (error) {
                const message = error?.message || String(error);
                console.error(`[${label}] Placement failed attempt ${attempt}: ${message}`);
                await positionService.updateLifecycle(position.id, {
                    lastError: `[${label}] ${message}`
                });

                if (message.includes('already placed') || message.includes('Duplicate') || message.includes('ORDER REJECTED')) {
                    await tradeLifecycleService.record(position, `${label}_PLACE_REJECTED_OR_DUPLICATE`, { message, attempt });
                    return null;
                }

                if (attempt === attempts) {
                    await tradeLifecycleService.record(position, `${label}_PLACE_FAILED`, { message, attempt });
                    await this.markManualExitRequired(position, {
                        label,
                        message,
                        attempts,
                        orderPayload
                    });
                    return null;
                }

                const delayMs = 1000 * (2 ** (attempt - 1));
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        return null;
    }

    async markManualExitRequired(position, details = {}) {
        const payload = {
            tradeId: position.id,
            accountId: position.account_id,
            tradingsymbol: position.tradingsymbol,
            exchange: position.exchange,
            quantity: Number(position.quantity),
            transactionType: position.transaction_type,
            product: position.product || 'CNC',
            message: 'Automatic exit order failed. Please exit this position manually.',
            ...details,
            timestamp: new Date().toISOString()
        };

        await positionService.updateLifecycle(position.id, {
            lifecycleStatus: 'MANUAL_EXIT_REQUIRED',
            lastError: payload.message
        });
        await tradeLifecycleService.record(position, 'MANUAL_EXIT_REQUIRED', payload, position.entry_order_id);

        try {
            getIO().emit('exit:manual_required', payload);
        } catch {
            // Dashboard clients may be disconnected; database state persists the alert.
        }

        console.error(`[EXIT] Manual exit required for trade ${position.id} ${position.tradingsymbol}`);
    }

    async handleExitUpdate(position, order, exitKind) {
        if (!isComplete(order)) return;
        if (String(position.lifecycle_status || '') === 'CLOSED') return;

        const isTarget = exitKind === 'TARGET';
        const closeStatus = isTarget ? 'TARGET_HIT' : 'STOPLOSS_HIT';
        const oppositeOrderId = isTarget ? position.stoploss_order_id : position.target_order_id;
        const exitPrice = toNumber(order.average_price) || toNumber(order.price) || (isTarget ? toNumber(position.target_price) : toNumber(position.stoploss_price)) || 0;

        await positionService.updateLifecycle(position.id, {
            lifecycleStatus: closeStatus,
            closedReason: closeStatus
        });
        await tradeLifecycleService.record(position, closeStatus, order, order.order_id);

        console.log(isTarget ? '[OCO] Target hit' : '[OCO] Stop loss hit');

        if (oppositeOrderId) {
            await this.cancelOppositeWithRetry(position, oppositeOrderId, isTarget ? 'stop loss' : 'target');
        }

        await positionService.closePosition(position.id, order.order_id, exitPrice, closeStatus);
        await tradeLifecycleService.record(position, 'CLOSED', { exitPrice, closeStatus }, order.order_id);
        this.emitManualExitCleared(position, order.order_id, closeStatus);
        console.log('[TRADE] Closed');
    }

    async findUntrackedExitPosition(accountId, order) {
        if (!isComplete(order)) return null;

        const activePositions = await positionService.getLifecycleActiveByAccount(accountId);
        const orderSide = String(order.transaction_type || '').toUpperCase();
        const orderSymbol = String(order.tradingsymbol || '').toUpperCase();
        const orderExchange = String(order.exchange || '').toUpperCase();

        return activePositions.find(position => (
            (position.exit_gtt_id || position.target_order_id || position.stoploss_order_id || isManualExitRequired(position)) &&
            String(position.tradingsymbol || '').toUpperCase() === orderSymbol &&
            String(position.exchange || '').toUpperCase() === orderExchange &&
            oppositeTransactionType(position.transaction_type) === orderSide
        )) || null;
    }

    async findUntrackedEntryPosition(accountId, order) {
        if (!isComplete(order)) return null;

        const activePositions = await positionService.getOpenPositionsByAccount(accountId);
        const orderSide = String(order.transaction_type || '').toUpperCase();
        const orderSymbol = String(order.tradingsymbol || '').toUpperCase();
        const orderExchange = String(order.exchange || '').toUpperCase();

        return activePositions.find(position => (
            String(position.tradingsymbol || '').toUpperCase() === orderSymbol &&
            String(position.exchange || '').toUpperCase() === orderExchange &&
            String(position.transaction_type || '').toUpperCase() === orderSide &&
            // entry not yet recorded for this position
            (!position.entry_order_id || String(position.entry_order_id) !== String(order.order_id)) &&
            // only consider positions that are awaiting entry or are managed
            (String(position.lifecycle_status || '').toUpperCase() === 'ENTRY_PENDING' || position.managed)
        )) || null;
    }

    async handleUntrackedEntryUpdate(position, order) {
        if (!isComplete(order)) return;

        const averagePrice = toNumber(order.average_price) || toNumber(order.price) || null;
        const entryPrice = averagePrice;

        try {
            // record entry order and price on the position
            if (entryPrice !== null) {
                await positionService.setEntryOrder(position.id, order.order_id, entryPrice);
            } else {
                await positionService.setEntryOrder(position.id, order.order_id, null);
            }

            await positionService.updateLifecycle(position.id, {
                lifecycleStatus: 'ENTRY_FILLED'
            });

            await tradeLifecycleService.record(position, 'ENTRY_FILLED', order, order.order_id);
            console.log(`[ENTRY-UNTRACKED] Order executed ${order.order_id} for position ${position.id}`);

            const freshPosition = await positionService.getById(position.id);
            // attempt to place exits if the position is managed
            await this.placeExitOrders(freshPosition || { ...position, entry_price: entryPrice });
        } catch (error) {
            console.error('[ENTRY-UNTRACKED] Failed handling untracked entry:', error?.message || error);
        }
    }

    async handleUntrackedExitUpdate(position, order) {
        if (String(position.lifecycle_status || '') === 'CLOSED') return;

        const exitPrice = toNumber(order.average_price) || toNumber(order.price) || 0;
        const side = String(position.transaction_type || '').toUpperCase();
        const targetPrice = toNumber(position.target_price);
        const stopLossPrice = toNumber(position.stoploss_price);
        const isTarget = side === 'BUY'
            ? exitPrice >= (targetPrice ?? Number.POSITIVE_INFINITY)
            : exitPrice <= (targetPrice ?? Number.NEGATIVE_INFINITY);
        const closeStatus = isTarget ? 'TARGET_HIT' : 'STOPLOSS_HIT';

        if (isTarget) {
            await positionService.setTargetOrder(position.id, order.order_id, targetPrice);
        } else {
            await positionService.setStopLossOrder(position.id, order.order_id, stopLossPrice);
        }

        await this.cancelAllExitOrders(position);

        await positionService.updateLifecycle(position.id, {
            lifecycleStatus: closeStatus,
            closedReason: closeStatus
        });
        await tradeLifecycleService.record(position, closeStatus, {
            ...order,
            gttId: position.exit_gtt_id,
            stopLossPrice,
            targetPrice
        }, order.order_id);

        console.log(isTarget ? '[GTT] Target hit' : '[GTT] Stop loss hit');

        await positionService.closePosition(position.id, order.order_id, exitPrice, closeStatus);
        await tradeLifecycleService.record(position, 'CLOSED', { exitPrice, closeStatus, gttId: position.exit_gtt_id }, order.order_id);
        this.emitManualExitCleared(position, order.order_id, closeStatus);
        console.log('[TRADE] Closed');

        const orderQty = getOrderFilledQuantity(order);
        const positionQty = toNumber(position.quantity) || 0;
        const excessQty = orderQty > positionQty ? orderQty - positionQty : 0;
        const entryPrice = getOrderExecutionPrice(order);

        if (excessQty > 0) {
            const reverseSide = oppositeTransactionType(position.transaction_type);
            const newPosition = await positionService.create(
                {
                    accountId: position.account_id,
                    tradingsymbol: position.tradingsymbol,
                    exchange: position.exchange,
                    transaction_type: reverseSide,
                    product: position.product || 'NRML',
                    quantity: excessQty,
                    targetPoints: null,
                    stopLossPoints: null,
                    exchangeToken: position.exchange_token ?? null
                },
                order.order_id
            );

            if (entryPrice !== null) {
                await positionService.updateEntryPrice(order.order_id, entryPrice);
            }

            await this.registerEntry(newPosition);
            console.log(`[MANUAL] Created reverse position ${newPosition.id} for excess quantity ${excessQty}`);
        }
    }

    emitManualExitCleared(position, orderId, closeStatus) {
        try {
            getIO().emit('exit:manual_cleared', {
                tradeId: position.id,
                accountId: position.account_id,
                orderId,
                closeStatus,
                timestamp: new Date().toISOString()
            });
        } catch {
            // Dashboard clients may be disconnected.
        }
    }

    async cancelOppositeWithRetry(position, orderId, label, attempts = 3) {
        console.log(`[OCO] Cancelling ${label} order ${orderId}`);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await kite.cancelOrder(orderId, position.account_id);
                await tradeLifecycleService.record(position, 'OCO_CANCELLED', { label, attempt }, orderId);
                console.log(`[OCO] ${label} cancelled`);
                return true;
            } catch (error) {
                const message = error?.message || String(error);
                console.error(`[OCO] Cancel ${label} failed attempt ${attempt}: ${message}`);

                if (attempt === attempts || isOrderLimitMessage(message)) {
                    await positionService.updateLifecycle(position.id, {
                        lastError: `[OCO] Cancel ${label} failed: ${message}`
                    });
                    await tradeLifecycleService.record(position, 'OCO_CANCEL_FAILED', { label, message }, orderId);
                    return false;
                }

                await new Promise(resolve => setTimeout(resolve, 250 * attempt));
            }
        }

        return false;
    }

    // =========================
    // SIGNAL REVERSAL HANDLING
    // =========================
    /**
     * Cancel all active exit orders (TP, SL, GTT) for a position
     * @param {Object} position
     * @returns {Promise<boolean>} - true if all cancelled successfully
     */
    async cancelAllExitOrders(position) {
        if (!position) return true;

        const exitDetails = positionService.getExitOrderDetails(position);
        const { targetOrderId, stopLossOrderId, gttId } = exitDetails;

        console.log(`[REVERSAL] Cancelling exit orders for position ${position.id}`);

        let allCancelled = true;

        // Cancel GTT if exists
        if (gttId) {
            try {
                await kite.deleteGTT(gttId, position.account_id);
                await tradeLifecycleService.record(position, 'SIGNAL_REVERSAL_GTT_CANCELLED', { gttId }, gttId);
                console.log(`[REVERSAL] GTT ${gttId} cancelled`);
            } catch (error) {
                console.error(`[REVERSAL] Failed to cancel GTT ${gttId}:`, error?.message);
                allCancelled = false;
            }
        }

        // Cancel Target Order
        if (targetOrderId) {
            const cancelled = await this.cancelOppositeWithRetry(position, targetOrderId, 'target order (reversal)');
            if (!cancelled) allCancelled = false;
        }

        // Cancel Stop Loss Order
        if (stopLossOrderId) {
            const cancelled = await this.cancelOppositeWithRetry(position, stopLossOrderId, 'stop loss order (reversal)');
            if (!cancelled) allCancelled = false;
        }

        if (allCancelled) {
            console.log(`[REVERSAL] All exit orders cancelled for position ${position.id}`);
        }

        return allCancelled;
    }

    /**
     * Close running position for signal reversal
     * @param {Object} position
     * @returns {Promise<boolean>}
     */
    async closePositionForReversal(position) {
        if (!position) return true;

        try {
            // If there's an entry order that's not fully filled, try to cancel it
            if (position.entry_order_id && position.status !== 'CLOSED') {
                try {
                    await kite.cancelOrder(position.entry_order_id, position.account_id);
                    console.log(`[REVERSAL] Entry order ${position.entry_order_id} cancelled`);
                    await tradeLifecycleService.record(position, 'ENTRY_CANCELLED_FOR_REVERSAL', {}, position.entry_order_id);
                } catch (error) {
                    console.warn(`[REVERSAL] Could not cancel entry order: ${error?.message}`);
                }
            }

            const exitSide = oppositeTransactionType(position.transaction_type);
            const quantity = Number(position.quantity) || 0;
            const closePayload = {
                exchange: position.exchange,
                tradingsymbol: position.tradingsymbol,
                transaction_type: exitSide,
                quantity,
                order_type: 'MARKET',
                product: position.product || 'NRML',
                validity: 'DAY'
            };

            if (quantity <= 0) {
                throw new Error('Invalid quantity for reversal close');
            }

            console.log(`[REVERSAL] Placing market close order for position ${position.id}:`, closePayload);
            const closeOrderResult = await kite.placeOrder(closePayload, position.account_id);
            const closeOrderId = extractOrderId(closeOrderResult);
            const exitPrice = getOrderExecutionPrice(closeOrderResult) || position.entry_price || 0;

            if (!closeOrderId) {
                throw new Error('Broker did not return an order_id for reversal close');
            }

            await positionService.closePosition(position.id, closeOrderId, exitPrice, 'REVERSAL_CLOSED');
            await tradeLifecycleService.record(position, 'REVERSAL_CLOSED', { closeOrderId, exitPrice }, closeOrderId);

            console.log(`[REVERSAL] Position ${position.id} closed for signal reversal with order ${closeOrderId}`);
            return true;
        } catch (error) {
            console.error(`[REVERSAL] Failed to close position: ${error?.message}`);
            return false;
        }
    }
}

export default new TpSlService();
