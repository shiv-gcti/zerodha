import db from './dbService.js';

const ensureColumnIfMissing = async (tableName, columnName, columnDefinition) => {
    const tableInfo = await db.query(`PRAGMA table_info(${tableName})`);
    const exists = (tableInfo.rows || []).some((column) => column.name === columnName);
    if (!exists) {
        await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
    }
};

class TradeLifecycleService {
    constructor() {
        this.schemaReady = false;
    }

    async ensureSchema() {
        if (this.schemaReady) return;

        await db.query(`
            CREATE TABLE IF NOT EXISTS trade_lifecycle_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_id INTEGER,
                account_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                order_id TEXT,
                payload TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        await ensureColumnIfMissing('trade_positions', 'managed', 'managed INTEGER NOT NULL DEFAULT 0');
        await ensureColumnIfMissing('trade_positions', 'product', "product TEXT NOT NULL DEFAULT 'CNC'");
        await ensureColumnIfMissing('trade_positions', 'lifecycle_status', "lifecycle_status TEXT NOT NULL DEFAULT 'ENTRY_PENDING'");
        await ensureColumnIfMissing('trade_positions', 'target_order_id', 'target_order_id TEXT');
        await ensureColumnIfMissing('trade_positions', 'stoploss_order_id', 'stoploss_order_id TEXT');
        await ensureColumnIfMissing('trade_positions', 'target_price', 'target_price REAL');
        await ensureColumnIfMissing('trade_positions', 'stoploss_price', 'stoploss_price REAL');
        await ensureColumnIfMissing('trade_positions', 'exit_gtt_id', 'exit_gtt_id TEXT');
        await ensureColumnIfMissing('trade_positions', 'exit_gtt_type', 'exit_gtt_type TEXT');
        await ensureColumnIfMissing('trade_positions', 'closed_reason', 'closed_reason TEXT');
        await ensureColumnIfMissing('trade_positions', 'last_error', 'last_error TEXT');
        await ensureColumnIfMissing('trade_positions', 'exit_place_cooldown_until', 'exit_place_cooldown_until TEXT');
        await ensureColumnIfMissing('trade_positions', 'updated_at', "updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
        await ensureColumnIfMissing('trade_lifecycle_events', 'account_id', 'account_id TEXT');

        await db.query(`
            CREATE INDEX IF NOT EXISTS trade_positions_entry_order_id_idx
            ON trade_positions (entry_order_id);

            CREATE INDEX IF NOT EXISTS trade_positions_lifecycle_status_idx
            ON trade_positions (lifecycle_status);

            CREATE INDEX IF NOT EXISTS trade_positions_target_order_id_idx
            ON trade_positions (target_order_id)
            WHERE target_order_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS trade_positions_stoploss_order_id_idx
            ON trade_positions (stoploss_order_id)
            WHERE stoploss_order_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS trade_positions_exit_gtt_id_idx
            ON trade_positions (exit_gtt_id)
            WHERE exit_gtt_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS trade_lifecycle_events_trade_id_idx
            ON trade_lifecycle_events (trade_id, created_at DESC);

            CREATE UNIQUE INDEX IF NOT EXISTS trade_lifecycle_events_order_event_uidx
            ON trade_lifecycle_events (trade_id, account_id, event_type, order_id)
            WHERE order_id IS NOT NULL;
        `);

        const rows = await db.query(`SELECT * FROM trade_lifecycle_events WHERE 0 = 1`);
        if (!rows || !Array.isArray(rows.rows)) {
            throw new Error('Trade lifecycle schema initialization failed');
        }

        this.schemaReady = true;
    }

    async record(position, eventType, payload = {}, orderId = null) {
        await this.ensureSchema();

        if (!position?.id) return;

        const accountId = position.account_id || position.accountId || 'UNKNOWN';
        const normalizedOrderId = orderId === null || orderId === undefined || orderId === ''
            ? null
            : String(orderId);

        if (normalizedOrderId) {
            await db.query(
                `
                INSERT OR IGNORE INTO trade_lifecycle_events
                (trade_id, account_id, event_type, order_id, payload)
                VALUES (?, ?, ?, ?, ?)
                `,
                [position.id, accountId, eventType, normalizedOrderId, JSON.stringify(payload || {})]
            );
            return;
        }

        await db.query(
            `
            INSERT INTO trade_lifecycle_events
            (trade_id, account_id, event_type, order_id, payload)
            VALUES (?, ?, ?, ?, ?)
            `,
            [position.id, accountId, eventType, null, JSON.stringify(payload || {})]
        );
    }
}

export default new TradeLifecycleService();
