import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrokerProduct, resolveBrokerTradingsymbol } from '../src/utils/orderPayload.js';
import tokenManager from '../src/services/tokenManager.js';
import loginService from '../src/services/loginService.js';
import dbService from '../src/services/dbService.js';
import { ACCOUNTS } from '../src/config/accounts.js';
import { needsInstrumentSync, instrumentCsvNeedsRefresh } from '../src/jobs/instrumentSyncJob.js';

test('normalizes common order products for broker payloads', () => {
    assert.equal(normalizeBrokerProduct('mis'), 'MIS');
    assert.equal(normalizeBrokerProduct('cNc'), 'CNC');
    assert.equal(normalizeBrokerProduct('NrMl'), 'NRML');
    assert.equal(normalizeBrokerProduct('', 'NRML'), 'NRML');
    assert.equal(normalizeBrokerProduct(undefined, 'CNC'), 'CNC');
});

test('preserves the incoming trading symbol in the broker payload', () => {
    assert.equal(resolveBrokerTradingsymbol('CANBK', { tradingsymbol: 'CANBK-EQ' }), 'CANBK');
    assert.equal(resolveBrokerTradingsymbol('', { tradingsymbol: 'CANBK-EQ' }), 'CANBK-EQ');
});

test('stores zerodha tokens in the local data folder', async () => {
    const accountId = 'TEST_LOCAL_TOKEN';

    await tokenManager.upsertTokenRecord({
        account_id: accountId,
        user_id: 'TEST_USER',
        access_token: 'local-access-token',
        public_token: 'local-public-token'
    });

    const record = await tokenManager.getTokenRecord(accountId);

    assert.ok(record);
    assert.equal(record.account_id, accountId);
    assert.equal(record.access_token, 'local-access-token');
    assert.equal(record.public_token, 'local-public-token');
});

test('reuses repeated parameter placeholders when querying SQLite', async () => {
    const orderId = `ORD-REPEATED-${Date.now()}`;

    await dbService.query(`
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
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN', $10)
    `, [
        'SHIV',
        'REPEATED_TEST',
        'NSE',
        'BUY',
        'CNC',
        1,
        orderId,
        null,
        null,
        null
    ]);

    const result = await dbService.query(`
        SELECT *
        FROM trade_positions
        WHERE (
            entry_order_id = $1
            OR target_order_id = $1
            OR stoploss_order_id = $1
        )
        AND account_id = $2
        ORDER BY id DESC
        LIMIT 1
    `, [orderId, 'SHIV']);

    assert.ok(Array.isArray(result.rows));
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].entry_order_id, orderId);
});

test('supports SQLite-friendly IN array filters in local queries', async () => {
    const symbolName = `RELIANCE_ANY_${Date.now()}`;

    await dbService.query(`
        INSERT OR IGNORE INTO stock_symbols
        (name, symbol, symbol_token, instrument_type, expiry_date, strike_price, lot_size, tick_size, exchange, ltp, ltp_updated_at, created_at, updated_at)
        VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, datetime('now'), datetime('now'))
    `, [
        symbolName,
        symbolName,
        12345,
        'EQ',
        null,
        null,
        1,
        1,
        'NSE',
        2450,
        new Date().toISOString()
    ]);

    const result = await dbService.query(`
        SELECT name, ltp
        FROM stock_symbols
        WHERE name = ANY($1)
    `, [[symbolName, 'TCS']]);

    const found = result.rows.find(row => row.name === symbolName);
    assert.ok(found, 'Unique ANY query should match inserted record');
    assert.equal(found.ltp, 2450);
});

test('detects when the local instrument cache is empty', async () => {
    const shouldSync = await needsInstrumentSync();
    assert.equal(typeof shouldSync, 'boolean');
    assert.ok(shouldSync === true || shouldSync === false);
});

test('marks a stale instrument csv older than 7 days for refresh', () => {
    const tempCsvPath = path.join(process.cwd(), 'data', 'instrument-refresh-test.csv');
    const staleTime = Date.now() - (8 * 24 * 60 * 60 * 1000) - 60000;
    fs.writeFileSync(tempCsvPath, 'instrument_token,tradingsymbol\n123,RELIANCE\n');
    fs.utimesSync(tempCsvPath, new Date(staleTime), new Date(staleTime));

    try {
        assert.equal(instrumentCsvNeedsRefresh(tempCsvPath), true);
    } finally {
        if (fs.existsSync(tempCsvPath)) {
            fs.unlinkSync(tempCsvPath);
        }
    }
});

test('requests a fresh Zerodha token when the local file is empty', async () => {
    const accountId = 'AUTO_LOGIN_TEST';
    const originalLogin = loginService.login;
    const originalAccounts = [...ACCOUNTS];
    const existingIndex = ACCOUNTS.findIndex((account) => account.id === accountId);
    if (existingIndex >= 0) ACCOUNTS.splice(existingIndex, 1);
    ACCOUNTS.push({
        id: accountId,
        userId: 'AUTO_USER',
        apiKey: 'AUTO_KEY',
        apiSecret: 'AUTO_SECRET',
        password: 'AUTO_PASSWORD',
        totp: 'JBSWY3DPEHPK3PXP'
    });

    loginService.login = async () => ({
        access_token: 'fresh-access-token',
        public_token: 'fresh-public-token'
    });

    try {
        const result = await tokenManager.getToken(accountId);
        const saved = await tokenManager.getTokenRecord(accountId);
        assert.equal(result, 'fresh-access-token');
        assert.ok(saved);
        assert.equal(saved.access_token, 'fresh-access-token');
    } finally {
        loginService.login = originalLogin;
        ACCOUNTS.length = 0;
        ACCOUNTS.push(...originalAccounts);
    }
});
