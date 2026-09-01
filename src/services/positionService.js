import db from './dbService.js';
import tradeLifecycleService from './tradeLifecycleService.js';

class PositionService {

    // =========================
    // CREATE POSITION (ENTRY)
    // =========================
    async create(orderPayload, orderId) {
        await tradeLifecycleService.ensureSchema();

        const existing = await this.getByOrderId(orderId);
        if (existing) return existing;

        const result = await db.query(
            `
            INSERT INTO trade_positions
            (
                account_id,
                tradingsymbol,
                exchange,
                transaction_type,
                product,
                quantity,
                entry_order_id,
                target_points,
                stoploss_points,
                status,
                exchange_token
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN',$10)
            RETURNING *
            `,
            [
                orderPayload.accountId,
                orderPayload.tradingsymbol,
                orderPayload.exchange,
                orderPayload.transaction_type,
                orderPayload.product || 'CNC',
                orderPayload.quantity,
                orderId,
                orderPayload.targetPoints || null,
                orderPayload.stopLossPoints || null,
                orderPayload.exchangeToken ?? null
            ]
        );

        return result.rows[0];
    }

    // =========================
    // UPDATE ENTRY PRICE
    // =========================
    async updateEntryPrice(orderId, entryPrice) {

        await db.query(
            `
            UPDATE trade_positions
            SET entry_price = $1,
                status = 'ACTIVE'
            WHERE entry_order_id = $2
            `,
            [entryPrice, orderId]
        );
    }

    // =========================
    // SET ENTRY ORDER + PRICE FOR UNTRACKED ENTRIES
    // =========================
    async setEntryOrder(positionId, orderId, entryPrice) {
        await db.query(
            `
            UPDATE trade_positions
            SET entry_order_id = $1,
                entry_price = $2,
                status = 'ACTIVE'
            WHERE id = $3
              AND (entry_order_id IS NULL OR entry_order_id <> $1)
            `,
            [orderId, entryPrice, positionId]
        );
    }

    // =========================
    // GET OPEN POSITIONS
    // =========================
    async getOpenPositionsByAccount(accountId) {

        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE status IN ('OPEN','ACTIVE')
            AND account_id = $1
            ORDER BY id DESC
            `,
            [accountId]
        );

        return result.rows;
    }

    async getOpenPositionsBySymbolAndExchange(symbol, exchange) {
        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE status IN ('OPEN','ACTIVE')
              AND tradingsymbol = $1
              AND exchange = $2
            ORDER BY id DESC
            `,
            [symbol, exchange]
        );

        return result.rows;
    }

    async getOpenPositions() {
        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE status IN ('OPEN','ACTIVE')
            ORDER BY id DESC
            `,
            []
        );

        return result.rows;
    }

    // =========================
    // CLOSE POSITION
    // =========================
    async closePosition(positionId, exitOrderId, exitPrice, lifecycleStatus = 'CLOSED') {

        const pnl = await this.calculatePnL(positionId, exitPrice);

        await db.query(
            `
            UPDATE trade_positions
            SET
                status = 'CLOSED',
                exit_order_id = $1,
                exit_price = $2,
                pnl = $3,
                closed_at = NOW(),
                lifecycle_status = $5,
                closed_reason = $5,
                updated_at = NOW()
            WHERE id = $4
            `,
            [
                exitOrderId,
                exitPrice,
                pnl,
                positionId,
                lifecycleStatus
            ]
        );
    }

    // =========================
    // PnL CALCULATION ENGINE
    // =========================
    async calculatePnL(positionId, exitPrice) {

        const result = await db.query(
            `
            SELECT entry_price, quantity, transaction_type
            FROM trade_positions
            WHERE id = $1
            `,
            [positionId]
        );

        const pos = result.rows[0];

        if (!pos || !pos.entry_price) return 0;

        const diff =
            pos.transaction_type === 'BUY'
                ? exitPrice - pos.entry_price
                : pos.entry_price - exitPrice;

        return diff * pos.quantity;
    }

    // =========================
    // GET BY ORDER ID
    // =========================
    async getByOrderId(orderId) {

        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE entry_order_id = $1
            LIMIT 1
            `,
            [orderId]
        );

        return result.rows[0] || null;
    }

    async getById(positionId) {
        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE id = $1
            LIMIT 1
            `,
            [positionId]
        );

        return result.rows[0] || null;
    }

    async getByAnyOrderId(orderId, accountId = null) {
        await tradeLifecycleService.ensureSchema();

        const params = [orderId];
        const accountFilter = accountId ? 'AND account_id = $2' : '';

        if (accountId) {
            params.push(accountId);
        }

        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE (
                entry_order_id = $1
                OR target_order_id = $1
                OR stoploss_order_id = $1
            )
            ${accountFilter}
            ORDER BY id DESC
            LIMIT 1
            `,
            params
        );

        return result.rows[0] || null;
    }

    async getByGttId(gttId, accountId = null) {
        await tradeLifecycleService.ensureSchema();

        const params = [String(gttId)];
        const accountFilter = accountId ? 'AND account_id = $2' : '';

        if (accountId) {
            params.push(accountId);
        }

        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE exit_gtt_id = $1
            ${accountFilter}
            ORDER BY id DESC
            LIMIT 1
            `,
            params
        );

        return result.rows[0] || null;
    }

    async getLifecycleActiveByAccount(accountId) {
        await tradeLifecycleService.ensureSchema();

        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE account_id = $1
              AND lifecycle_status IN (
                'ENTRY_PENDING',
                'ENTRY_FILLED',
                'TARGET_PLACED',
                'STOPLOSS_PLACED',
                'GTT_OCO_PLACED',
                'MANUAL_EXIT_REQUIRED',
                'ACTIVE'
              )
            ORDER BY id DESC
            `,
            [accountId]
        );

        return result.rows;
    }

    async updateLifecycle(positionId, updates = {}) {
        await tradeLifecycleService.ensureSchema();

        const fields = [];
        const params = [];

        if (updates.managed !== undefined) {
            params.push(updates.managed);
            fields.push(`managed = $${params.length}`);
        }

        if (updates.lifecycleStatus !== undefined) {
            params.push(updates.lifecycleStatus);
            fields.push(`lifecycle_status = $${params.length}`);
        }

        if (updates.closedReason !== undefined) {
            params.push(updates.closedReason);
            fields.push(`closed_reason = $${params.length}`);
        }

        if (updates.lastError !== undefined) {
            params.push(updates.lastError);
            fields.push(`last_error = $${params.length}`);
        }

        if (updates.exitPlaceCooldownUntil !== undefined) {
            params.push(updates.exitPlaceCooldownUntil);
            fields.push(`exit_place_cooldown_until = $${params.length}`);
        }

        if (!fields.length) return;

        params.push(positionId);

        await db.query(
            `
            UPDATE trade_positions
            SET ${fields.join(', ')},
                updated_at = NOW()
            WHERE id = $${params.length}
            `,
            params
        );
    }

    async setTargetOrder(positionId, orderId, targetPrice) {
        await tradeLifecycleService.ensureSchema();

        await db.query(
            `
            UPDATE trade_positions
            SET target_order_id = $1,
                target_price = $2,
                lifecycle_status = 'TARGET_PLACED',
                updated_at = NOW()
            WHERE id = $3
              AND target_order_id IS NULL
            `,
            [orderId, targetPrice, positionId]
        );
    }

    async setStopLossOrder(positionId, orderId, stopLossPrice) {
        await tradeLifecycleService.ensureSchema();

        await db.query(
            `
            UPDATE trade_positions
            SET stoploss_order_id = $1,
                stoploss_price = $2,
                lifecycle_status = 'STOPLOSS_PLACED',
                updated_at = NOW()
            WHERE id = $3
              AND stoploss_order_id IS NULL
            `,
            [orderId, stopLossPrice, positionId]
        );
    }

    async setExitGtt(positionId, gttId, targetPrice, stopLossPrice) {
        await tradeLifecycleService.ensureSchema();

        await db.query(
            `
            UPDATE trade_positions
            SET exit_gtt_id = $1,
                exit_gtt_type = 'OCO',
                target_price = $2,
                stoploss_price = $3,
                lifecycle_status = 'GTT_OCO_PLACED',
                updated_at = NOW()
            WHERE id = $4
              AND exit_gtt_id IS NULL
            `,
            [String(gttId), targetPrice, stopLossPrice, positionId]
        );
    }

    // =========================
    // SIGNAL REVERSAL DETECTION
    // =========================
    /**
     * Get active position with opposite transaction type for same symbol+exchange
     * @param {string} accountId
     * @param {string} symbol
     * @param {string} exchange
     * @param {string} transactionType - 'BUY' or 'SELL'
     * @returns {Promise<Object|null>}
     */
    async getActiveOppositePosition(accountId, symbol, exchange, transactionType) {
        const oppositeType = String(transactionType).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
        
        const result = await db.query(
            `
            SELECT *
            FROM trade_positions
            WHERE account_id = $1
              AND tradingsymbol = $2
              AND exchange = $3
              AND transaction_type = $4
              AND status IN ('OPEN', 'ACTIVE')
            LIMIT 1
            `,
            [accountId, symbol, exchange, oppositeType]
        );

        return result.rows[0] || null;
    }

    /**
     * Check if position has unfinished TP/SL orders
     * @param {Object} position
     * @returns {boolean}
     */
    hasActiveExitOrders(position) {
        return !!(position.target_order_id || position.stoploss_order_id || position.exit_gtt_id);
    }

    /**
     * Get exit order details
     * @param {Object} position
     * @returns {Object}
     */
    getExitOrderDetails(position) {
        return {
            targetOrderId: position.target_order_id,
            stopLossOrderId: position.stoploss_order_id,
            gttId: position.exit_gtt_id,
            targetPrice: position.target_price,
            stopLossPrice: position.stoploss_price,
            hasActiveExits: this.hasActiveExitOrders(position)
        };
    }
}

export default new PositionService();
