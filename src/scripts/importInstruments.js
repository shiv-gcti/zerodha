import fs from 'fs';
import csv from 'csv-parser';
import dns from 'dns';
import dotenv from 'dotenv';
import path from 'path';
import Database from 'better-sqlite3';

dotenv.config();
dns.setDefaultResultOrder('ipv4first');

const filePath = './instruments.csv';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app-local.db');
const BATCH_SIZE = 5000;

let buffer = [];
let total = 0;

const client = new Database(DB_PATH);
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

const flush = async () => {
    if (buffer.length === 0) return;

    const stmt = client.prepare(`
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

    for (const row of buffer) {
        stmt.run({
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

    total += buffer.length;
    console.log(`⚡ Inserted rows: ${total}`);
    buffer = [];
};

const run = async () => {
    console.log('🚀 Connecting...');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('✅ Connected');

    const stream = fs.createReadStream(filePath).pipe(csv());

    stream.on('data', async (row) => {
        buffer.push(mapRow(row));

        if (buffer.length >= BATCH_SIZE) {
            stream.pause();
            await flush();
            stream.resume();
        }
    });

    stream.on('end', async () => {
        await flush();
        client.close();
        console.log('🎉 IMPORT COMPLETE:', total);
    });
};

run();