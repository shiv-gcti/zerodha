import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app-local.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

class StockSymbolFillerService {
    constructor() {
        this.client = null;
        this.running = false;
    }

    async init() {
        this.client = new Database(DB_PATH);

        this.client.exec(`
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
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        this.client.exec(`
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
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        this.client.exec(`
            CREATE INDEX IF NOT EXISTS stock_symbols_symbol_token_idx
            ON stock_symbols (symbol_token);
        `);

        this.client.exec(`
            CREATE INDEX IF NOT EXISTS stock_symbols_name_idx
            ON stock_symbols (name);
        `);

        this.client.exec(`
            CREATE INDEX IF NOT EXISTS angel_instruments_symbol_idx
            ON angel_instruments (symbol);
        `);

        console.log('✅ Stock Symbol Filler DB Connected');
    }

    async process() {
        if (this.running) {
            console.log('⏳ Previous Stock Symbol Filler still running');
            return;
        }

        this.running = true;

        try {
            const rows = this.client.prepare(`
                SELECT * FROM stock_symbols
                WHERE symbol_token IS NULL
                   OR symbol IS NULL
                   OR instrument_type IS NULL
                   OR lot_size IS NULL
            `).all();

            let updated = 0;

            for (const row of rows) {
                const match = this.client.prepare(`
                    SELECT * FROM angel_instruments
                    WHERE symbol = ? OR name = ?
                    LIMIT 1
                `).get(row.name, row.name);

                if (!match) continue;

                const instrumentType = match.instrumenttype || this.inferInstrumentType(match.symbol);
                const strikePrice = match.strike && match.strike > 10000 ? match.strike / 100 : match.strike;

                this.client.prepare(`
                    UPDATE stock_symbols
                    SET symbol_token = COALESCE(symbol_token, ?),
                        symbol = COALESCE(symbol, ?),
                        instrument_type = COALESCE(instrument_type, ?),
                        expiry_date = COALESCE(expiry_date, ?),
                        strike_price = COALESCE(strike_price, ?),
                        lot_size = COALESCE(lot_size, ?),
                        tick_size = COALESCE(tick_size, ?),
                        exchange = COALESCE(exchange, ?),
                        updated_at = datetime('now')
                    WHERE id = ?
                `).run(
                    match.symbol_token,
                    match.symbol,
                    instrumentType,
                    match.expiry,
                    strikePrice,
                    match.lotsize,
                    match.tick_size,
                    match.exch_seg,
                    row.id
                );

                updated += 1;
            }

            console.log(`✅ Stock Symbol Filler updated ${updated} rows`);
        } catch (err) {
            console.error('❌ Stock Symbol Filler failed:', err.message);
        }

        this.running = false;
    }

    inferInstrumentType(symbol) {
        if (!symbol) return null;
        const upper = String(symbol).toUpperCase();
        if (upper.endsWith('CE') || upper.endsWith('PE')) return 'OPT';
        if (upper.includes('FUT')) return 'FUT';
        if (upper.endsWith('-EQ') || upper.endsWith(' EQ')) return 'EQ';
        return null;
    }

    async stop() {
        if (this.client) {
            this.client.close();
        }
        console.log('🛑 Stock Symbol Filler stopped');
    }
}

export default new StockSymbolFillerService();