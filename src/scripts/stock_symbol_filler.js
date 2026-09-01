import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app-local.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const INTERVAL_MS = 60 * 1000;

class StockSymbolFiller {
    constructor() {
        this.client = new Database(DB_PATH);
        this.running = false;
    }

    async start() {
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

        this.running = true;
        console.log('✅ DB Connected');
        console.log('🚀 Stock Symbol Filler started');

        while (this.running) {
            try {
                await this.process();
            } catch (err) {
                console.error('❌ Worker error:', err.message);
            }
            await this.sleep(INTERVAL_MS);
        }
    }

    async process() {
        const rows = this.client.prepare(`
            SELECT
                id,
                name,
                symbol,
                instrument_type,
                symbol_token,
                expiry_date,
                strike_price,
                lot_size,
                tick_size
            FROM stock_symbols
            WHERE symbol_token IS NULL
               OR symbol IS NULL
               OR instrument_type IS NULL
               OR lot_size IS NULL
            LIMIT 500
        `).all();

        if (rows.length === 0) {
            console.log('🟢 No incomplete stock symbols found');
            return;
        }

        console.log(`🔎 Found ${rows.length} incomplete rows`);

        for (const row of rows) {
            try {
                const match = this.client.prepare(`
                    SELECT * FROM angel_instruments
                    WHERE symbol = ? OR name = ?
                    LIMIT 1
                `).get(row.name, row.name);

                if (!match) {
                    console.log(`⚠️ No Angel match found for ${row.name}`);
                    continue;
                }

                const instrumentType = match.instrumenttype || this.inferInstrumentType(match.symbol);

                this.client.prepare(`
                    UPDATE stock_symbols
                    SET
                        symbol_token = COALESCE(symbol_token, ?),
                        symbol = COALESCE(symbol, ?),
                        instrument_type = COALESCE(instrument_type, ?),
                        expiry_date = COALESCE(expiry_date, ?),
                        strike_price = COALESCE(strike_price, ?),
                        lot_size = COALESCE(lot_size, ?),
                        tick_size = COALESCE(tick_size, ?),
                        updated_at = datetime('now')
                    WHERE id = ?
                `).run(
                    match.symbol_token,
                    match.symbol,
                    instrumentType,
                    match.expiry,
                    match.strike,
                    match.lotsize,
                    match.tick_size,
                    row.id
                );

                console.log(`✅ Updated ${row.name}`);
            } catch (err) {
                console.error(`❌ Failed updating ${row.name}:`, err.message);
            }
        }

        console.log('⚡ Batch processing complete');
    }

    inferInstrumentType(symbol) {
        if (!symbol) return null;
        const upper = symbol.toUpperCase();
        if (upper.endsWith('CE') || upper.endsWith('PE')) return 'OPT';
        if (upper.includes('FUT')) return 'FUT';
        if (upper.endsWith('-EQ') || upper.endsWith(' EQ')) return 'EQ';
        return null;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    stop() {
        this.running = false;
        this.client.close();
        console.log('🛑 Stock Symbol Filler stopped');
    }
}

export default new StockSymbolFiller();
        // ETFs
        if (
            upper.includes('ETF')
        ) {

            return 'ETF';
        }

        // Default
        return 'EQ';
    }

    sleep(ms) {

        return new Promise(resolve =>
            setTimeout(resolve, ms)
        );
    }

    async stop() {

        this.running = false;

        await this.client.end();

        console.log(
            '🛑 Stock Symbol Filler stopped'
        );
    }
}

export default StockSymbolFiller;

// Run directly
if (
    process.argv[1]?.includes(
        'stock_symbol_filler'
    )
) {

    const worker =
        new StockSymbolFiller();

    worker.start();

    process.on(
        'SIGINT',
        async () => {

            console.log(
                '\n⏹️ Shutting down...'
            );

            await worker.stop();

            process.exit(0);
        }
    );

    process.on(
        'SIGTERM',
        async () => {

            await worker.stop();

            process.exit(0);
        }
    );
}