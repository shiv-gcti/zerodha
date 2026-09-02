import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app-local.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

function makeCoreSchema() {
    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS zerodha_instruments (
            instrument_token INTEGER PRIMARY KEY,
            exchange_token INTEGER,
            tradingsymbol TEXT NOT NULL,
            name TEXT,
            last_price REAL,
            expiry TEXT,
            strike REAL,
            tick_size REAL,
            lot_size INTEGER,
            instrument_type TEXT,
            segment TEXT,
            exchange TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS angel_instruments (
            symbol_token INTEGER PRIMARY KEY,
            symbol TEXT,
            name TEXT,
            expiry TEXT,
            strike REAL,
            lotsize INTEGER,
            instrumenttype TEXT,
            exch_seg TEXT,
            tick_size REAL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS stock_symbols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            symbol TEXT,
            symbol_token INTEGER,
            instrument_type TEXT,
            expiry_date TEXT,
            strike_price REAL,
            lot_size INTEGER,
            tick_size REAL,
            exchange TEXT,
            ltp REAL,
            ltp_updated_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS trade_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            signal_id TEXT,
            tradingsymbol TEXT NOT NULL,
            exchange TEXT NOT NULL,
            transaction_type TEXT NOT NULL,
            product TEXT NOT NULL DEFAULT 'CNC',
            quantity INTEGER NOT NULL,
            entry_order_id TEXT,
            exit_order_id TEXT,
            entry_price REAL,
            exit_price REAL,
            target_points REAL,
            stoploss_points REAL,
            status TEXT NOT NULL DEFAULT 'OPEN',
            exchange_token TEXT,
            pnl REAL DEFAULT 0,
            managed INTEGER NOT NULL DEFAULT 0,
            lifecycle_status TEXT NOT NULL DEFAULT 'ENTRY_PENDING',
            target_order_id TEXT,
            stoploss_order_id TEXT,
            target_price REAL,
            stoploss_price REAL,
            exit_gtt_id TEXT,
            exit_gtt_type TEXT,
            closed_reason TEXT,
            last_error TEXT,
            exit_place_cooldown_until TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            closed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS trade_lifecycle_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id INTEGER,
            account_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            order_id TEXT,
            payload TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS order_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'RECEIVED',
            order_id TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS zerodha_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL UNIQUE,
            user_id TEXT,
            access_token TEXT,
            public_token TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS angel_tokens (
            id INTEGER PRIMARY KEY DEFAULT 1,
            access_token TEXT,
            refresh_token TEXT,
            feed_token TEXT,
            jwt_token TEXT,
            generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_trade_positions_account_status ON trade_positions(account_id, status);
        CREATE INDEX IF NOT EXISTS idx_trade_positions_status_created_at ON trade_positions(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_trade_positions_entry_order_id ON trade_positions(entry_order_id);
        CREATE INDEX IF NOT EXISTS idx_trade_positions_lifecycle_status ON trade_positions(lifecycle_status);
        CREATE INDEX IF NOT EXISTS idx_trade_lifecycle_events_trade_id ON trade_lifecycle_events(trade_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_order_logs_account_status_created_at ON order_logs(account_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_order_logs_created_at ON order_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_stock_symbols_symbol_token ON stock_symbols(symbol_token);
        CREATE INDEX IF NOT EXISTS idx_stock_symbols_name ON stock_symbols(name);
        CREATE INDEX IF NOT EXISTS idx_angel_instruments_symbol ON angel_instruments(symbol);
    `);
}

makeCoreSchema();

function normalizeSql(sql, params = []) {
    if (!sql) return { sql: '', params: [] };

    let normalized = String(sql)
        .replace(/CURRENT_DATE/gi, "date('now')")
        .replace(/NOW\(\)/gi, "datetime('now')")
        .replace(/::date\b/gi, '')
        .replace(/::text\b/gi, '')
        .replace(/::bigint\b/gi, '')
        .replace(/::int\b/gi, '')
        .replace(/::numeric\b/gi, '')
        .replace(/::timestamp\b/gi, '')
        .replace(/::timestamptz\b/gi, '')
        .replace(/::jsonb\b/gi, '')
        .replace(/BIGSERIAL\s+PRIMARY\s+KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/BIGSERIAL/gi, 'INTEGER')
        .replace(/TIMESTAMPTZ/gi, 'TEXT')
        .replace(/TIMESTAMP\s+WITH\s+TIME\s+ZONE/gi, 'TEXT')
        .replace(/JSONB/gi, 'TEXT')
        .replace(/DOUBLE\s+PRECISION/gi, 'REAL')
        .replace(/WEB\s*\(/gi, '');

    const values = Array.isArray(params) ? params : [params];
    const rehydratedParams = [];
    const hasDollarPlaceholders = /\$\d+/i.test(normalized);

    normalized = normalized.replace(/(\b[\w.]+\b)\s*=\s*ANY\(\s*\$(\d+)\s*\)/gi, (match, fieldName, placeholderIndex) => {
        const valueIndex = Number(placeholderIndex) - 1;
        const candidate = valueIndex >= 0 && valueIndex < values.length ? values[valueIndex] : [];
        const list = Array.isArray(candidate) ? candidate : [candidate];
        rehydratedParams.push(...list);
        return `${fieldName} IN (${list.map(() => '?').join(', ')})`;
    });

    normalized = normalized.replace(/ANY\(\s*\$(\d+)\s*\)/gi, (match, placeholderIndex) => {
        const valueIndex = Number(placeholderIndex) - 1;
        const candidate = valueIndex >= 0 && valueIndex < values.length ? values[valueIndex] : [];
        const list = Array.isArray(candidate) ? candidate : [candidate];
        rehydratedParams.push(...list);
        return `IN (${list.map(() => '?').join(', ')})`;
    });

    if (hasDollarPlaceholders) {
        normalized = normalized.replace(/\$(\d+)/g, (match, placeholderIndex) => {
            const valueIndex = Number(placeholderIndex) - 1;
            if (valueIndex >= 0 && valueIndex < values.length) {
                rehydratedParams.push(values[valueIndex]);
            }
            return '?';
        });

        return {
            sql: normalized,
            params: rehydratedParams
        };
    }

    return {
        sql: normalized,
        params: values
    };
}

class DBService {
    async query(sql, params = [], options = {}) {
        const { sql: normalizedSql, params: normalizedParams } = normalizeSql(sql, params);
        const statement = normalizedSql.trim();

        if (!statement) return { rows: [], rowCount: 0 };

        try {
            const selectLike = /^\s*(SELECT|WITH)\b/i.test(statement);
            const pragmaLike = /^\s*PRAGMA\b/i.test(statement);
            const insertLike = /^\s*INSERT\b/i.test(statement);
            const updateLike = /^\s*UPDATE\b/i.test(statement);
            const deleteLike = /^\s*DELETE\b/i.test(statement);
            const ddlLike = /^\s*(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(statement);

            if (selectLike || pragmaLike) {
                const rows = sqlite.prepare(normalizedSql).all(...normalizedParams);
                return { rows, rowCount: rows.length };
            }

            if (insertLike) {
                const result = sqlite.prepare(normalizedSql).run(...normalizedParams);
                const isReturning = /RETURNING\s+/i.test(statement);
                if (!isReturning) {
                    return { rows: [], rowCount: result.changes || 0 };
                }

                const tableMatch = statement.match(/^\s*INSERT\s+INTO\s+([A-Za-z0-9_]+)/i);
                const tableName = tableMatch ? tableMatch[1] : null;
                if (!tableName) return { rows: [], rowCount: result.changes || 0 };

                const rowId = Number(result.lastInsertRowid);
                const rows = sqlite.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).all(rowId);
                return { rows, rowCount: rows.length };
            }

            if (updateLike || deleteLike) {
                const result = sqlite.prepare(normalizedSql).run(...normalizedParams);
                return { rows: [], rowCount: result.changes || 0 };
            }

            if (ddlLike) {
                sqlite.exec(normalizedSql);
                return { rows: [], rowCount: 0 };
            }

            const result = sqlite.prepare(normalizedSql).run(...normalizedParams);
            return { rows: [], rowCount: result.changes || 0 };
        } catch (error) {
            if (options.allowFailure) {
                return { rows: [], rowCount: 0, error };
            }
            throw error;
        }
    }

    async close() {
        sqlite.close();
    }
}

export default new DBService();