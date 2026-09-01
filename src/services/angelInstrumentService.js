import axios from 'axios';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app-local.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const ANGEL_INSTRUMENT_URL =
    'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const BATCH_SIZE = 15000; // reduced for safety

class AngelInstrumentService {

    // =========================
    // MAIN SYNC
    // =========================
    async runSync() {

        console.log('🚀 Starting Angel Instrument Sync');

        const client = new Database(DB_PATH);

        let total = 0;

        try {

            console.log('✅ DB Connected');

            client.exec(`
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

            client.exec(`
                CREATE INDEX IF NOT EXISTS angel_instruments_symbol_idx
                ON angel_instruments (symbol);
            `);

            console.log('📡 Downloading Angel instruments...');

            const response = await axios.get(ANGEL_INSTRUMENT_URL, {
                timeout: 300000
            });

            const instruments = response.data;

            console.log(`📦 Total records received: ${instruments.length}`);

            const seen = new Set(); // 🔥 deduplication
            let buffer = [];

            for (const instrument of instruments) {

                const token = this.safeBigInt(instrument.token);
                if (token === null) continue;

                // 🔥 prevent duplicates inside same run
                if (seen.has(token)) continue;
                seen.add(token);

                const row = [
                    token,
                    instrument.symbol || null,
                    instrument.name || null,
                    this.parseExpiry(instrument.expiry),
                    this.parseStrike(instrument.strike),
                    instrument.lotsize ? Number(instrument.lotsize) : null,
                    instrument.instrumenttype || null,
                    instrument.exch_seg || null,
                    instrument.tick_size ? Number(instrument.tick_size) : null,
                    new Date().toISOString()
                ];

                buffer.push(row);

                if (buffer.length >= BATCH_SIZE) {
                    await this.flush(client, buffer);
                    total += buffer.length;
                    console.log(`⚡ Synced: ${total}`);
                    buffer = [];
                }
            }

            if (buffer.length > 0) {
                await this.flush(client, buffer);
                total += buffer.length;
                console.log(`⚡ Synced: ${total}`);
            }

            console.log('🎉 Angel Instrument Sync Complete');

        } catch (err) {
            console.error('❌ SYNC FAILED:', err.message);
            throw err;

        } finally {
            client.close();
        }
    }

    // =========================
    // BULK INSERT (SAFE)
    // =========================
async flush(client, buffer) {

    const query = `
        INSERT INTO angel_instruments (
            symbol_token,
            symbol,
            name,
            expiry,
            strike,
            lotsize,
            instrumenttype,
            exch_seg,
            tick_size,
            updated_at
        )
        VALUES ${buffer.map((row) => {
            return `(
                '${row[0]}',
                ${row[1] ? `'${row[1].replace(/'/g, "''")}'` : 'NULL'},
                ${row[2] ? `'${row[2].replace(/'/g, "''")}'` : 'NULL'},
                ${row[3] ? `'${row[3]}'` : 'NULL'},
                ${row[4] ?? 'NULL'},
                ${row[5] ?? 'NULL'},
                ${row[6] ? `'${row[6]}'` : 'NULL'},
                ${row[7] ? `'${row[7]}'` : 'NULL'},
                ${row[8] ?? 'NULL'},
                NOW()
            )`;
        }).join(',')}
        ON CONFLICT (symbol_token)
        DO UPDATE SET
            symbol = EXCLUDED.symbol,
            name = EXCLUDED.name,
            expiry = EXCLUDED.expiry,
            strike = EXCLUDED.strike,
            lotsize = EXCLUDED.lotsize,
            instrumenttype = EXCLUDED.instrumenttype,
            exch_seg = EXCLUDED.exch_seg,
            tick_size = EXCLUDED.tick_size,
            updated_at = NOW();
    `;

    client.exec(query);
}

    // =========================
    // SAFE BIGINT
    // =========================
    safeBigInt(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        return Math.floor(num);
    }

    // =========================
    // EXPIRY PARSER
    // =========================
    parseExpiry(expiry) {
        if (!expiry) return null;

        const date = new Date(expiry);
        if (isNaN(date.getTime())) return null;

        return date.toISOString().split('T')[0];
    }

    // =========================
    // STRIKE PARSER
    // =========================
    parseStrike(strike) {
        if (strike === undefined || strike === null || strike === '') return null;

        const num = Number(strike);
        if (!Number.isFinite(num)) return null;

        return num;
    }
}

export default new AngelInstrumentService();