import cron from 'node-cron';
import https from 'https';
import csv from 'csv-parser';
import dns from 'dns';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

dotenv.config();
dns.setDefaultResultOrder('ipv4first');

const BATCH_SIZE = 5000;
const CSV_URL = 'https://api.kite.trade/instruments';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app-local.db');
const LOCAL_INSTRUMENTS_CSV = path.join(DATA_DIR, 'instruments.csv');
const INSTRUMENT_CSV_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let buffer = [];
let total = 0;

const createClient = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return new Database(DB_PATH);
};

const mapRow = (row) => [
    Number(row.instrument_token),
    Number(row.exchange_token),
    row.tradingsymbol,
    row.name,
    row.last_price ? Number(row.last_price) : null,
    row.expiry || null,
    row.strike ? Number(row.strike) : null,
    row.tick_size ? Number(row.tick_size) : null,
    row.lot_size ? Number(row.lot_size) : null,
    row.instrument_type,
    row.segment,
    row.exchange,
    new Date().toISOString()
];

const flush = async (client) => {
    if (buffer.length === 0) return;

    const rowsToInsert = buffer.splice(0, buffer.length);
    const insertStatement = client.prepare(`
        INSERT INTO zerodha_instruments (
            instrument_token,
            exchange_token,
            tradingsymbol,
            name,
            last_price,
            expiry,
            strike,
            tick_size,
            lot_size,
            instrument_type,
            segment,
            exchange,
            updated_at
        ) VALUES (
            @instrument_token,
            @exchange_token,
            @tradingsymbol,
            @name,
            @last_price,
            @expiry,
            @strike,
            @tick_size,
            @lot_size,
            @instrument_type,
            @segment,
            @exchange,
            @updated_at
        )
        ON CONFLICT(instrument_token) DO UPDATE SET
            exchange_token = excluded.exchange_token,
            tradingsymbol = excluded.tradingsymbol,
            name = excluded.name,
            last_price = excluded.last_price,
            expiry = excluded.expiry,
            strike = excluded.strike,
            tick_size = excluded.tick_size,
            lot_size = excluded.lot_size,
            instrument_type = excluded.instrument_type,
            segment = excluded.segment,
            exchange = excluded.exchange,
            updated_at = excluded.updated_at
    `);

    for (const row of rowsToInsert) {
        insertStatement.run({
            instrument_token: row[0],
            exchange_token: row[1],
            tradingsymbol: row[2],
            name: row[3],
            last_price: row[4],
            expiry: row[5],
            strike: row[6],
            tick_size: row[7],
            lot_size: row[8],
            instrument_type: row[9],
            segment: row[10],
            exchange: row[11],
            updated_at: row[12]
        });
    }

    total += rowsToInsert.length;
    console.log(`⚡ Inserted rows: ${total}`);
};

const ensureDataDir = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
};

const writeLocalInstrumentSnapshot = async (rows) => {
    ensureDataDir();

    const header = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n';
    const lines = rows.map((row) => {
        const values = [
            row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11]
        ].map((value) => {
            if (value === null || value === undefined || value === '') return '';
            return String(value).replace(/"/g, '""');
        });

        return values.map((value) => {
            if (value.includes(',') || value.includes('"') || value.includes('\n')) return `"${value}"`;
            return value;
        }).join(',');
    });

    fs.writeFileSync(LOCAL_INSTRUMENTS_CSV, header + lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    console.log(`📝 Wrote local instrument snapshot to ${LOCAL_INSTRUMENTS_CSV}`);
};

export const needsInstrumentSync = async (clientOverride = null) => {
    const client = clientOverride || createClient();
    try {
        const result = client.prepare(`SELECT COUNT(*) AS count FROM zerodha_instruments`).get();
        return Number(result?.count || 0) === 0;
    } finally {
        if (!clientOverride) {
            client.close();
        }
    }
};

export const getInstrumentCsvAgeMs = (filePath = LOCAL_INSTRUMENTS_CSV) => {
    try {
        if (!fs.existsSync(filePath)) {
            return Number.MAX_SAFE_INTEGER;
        }
        const stat = fs.statSync(filePath);
        return Date.now() - stat.mtimeMs;
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
};

export const instrumentCsvNeedsRefresh = (filePath = LOCAL_INSTRUMENTS_CSV) => {
    return getInstrumentCsvAgeMs(filePath) > INSTRUMENT_CSV_MAX_AGE_MS;
};

export const refreshInstrumentCsvIfNeeded = async () => {
    const csvNeedsRefresh = instrumentCsvNeedsRefresh();
    const dbNeedsSync = await needsInstrumentSync();

    if (!csvNeedsRefresh && !dbNeedsSync) {
        console.log('✅ Local Zerodha instrument CSV is fresh and DB cache is populated; skipping refresh.');
        return { refreshed: false, reason: 'fresh-cache' };
    }

    console.log('📥 Zerodha instrument data is stale or missing; refreshing local CSV/cache now...');
    await runImport();
    return { refreshed: true, reason: csvNeedsRefresh ? 'stale-csv' : 'empty-cache' };
};

export const syncInstrumentsIfNeeded = async () => {
    const csvNeedsRefresh = instrumentCsvNeedsRefresh();
    const dbNeedsSync = await needsInstrumentSync();

    if (!csvNeedsRefresh && !dbNeedsSync) {
        console.log('✅ Zerodha instrument cache already populated and fresh; skipping startup sync.');
        return { synced: false, reason: 'already-populated' };
    }

    console.log('📥 Zerodha instrument data is stale or missing; running local startup sync now...');
    await runImport();
    return { synced: true, reason: csvNeedsRefresh ? 'stale-csv' : 'empty-cache' };
};

export const runImport = async () => {
    console.log('🚀 Starting Zerodha Instrument Sync (Live API)');
    buffer = [];
    total = 0;

    const client = createClient();

    client.exec(`
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
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    client.exec(`
        CREATE INDEX IF NOT EXISTS zerodha_instruments_tradingsymbol_idx
        ON zerodha_instruments (tradingsymbol);
    `);

    client.exec(`
        CREATE INDEX IF NOT EXISTS zerodha_instruments_exchange_idx
        ON zerodha_instruments (exchange);
    `);

    return new Promise((resolve, reject) => {
        const rows = [];

        https.get(CSV_URL, (res) => {
            console.log('📡 Fetching instruments from Zerodha...');
            res
                .pipe(csv())
                .on('data', (row) => rows.push(mapRow(row)))
                .on('end', async () => {
                    try {
                        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
                            buffer = rows.slice(i, i + BATCH_SIZE);
                            await flush(client);
                        }
                        await writeLocalInstrumentSnapshot(rows);
                        client.close();
                        console.log('🎉 SYNC COMPLETE. TOTAL ROWS:', total);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                })
                .on('error', reject);
        }).on('error', reject);
    });
};

export const startInstrumentSyncJob = () => {
    cron.schedule('0 6 * * 0', async () => {
        try {
            console.log('⏰ Sunday 6:00 AM IST - Instrument Sync Triggered');
            await runImport();
        } catch (err) {
            console.error('❌ Instrument Sync Failed:', err.message);
        }
    }, {
        timezone: 'Asia/Kolkata'
    });

    syncInstrumentsIfNeeded().catch((err) => {
        console.error('❌ Startup instrument sync failed:', err?.message || err);
    });

    console.log('📅 Instrument Sync Cron Scheduled (weekly on Sunday 6 AM IST)');
};