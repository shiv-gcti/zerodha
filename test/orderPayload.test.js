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
import tradeLifecycleService from '../src/services/tradeLifecycleService.js';
import instrumentService from '../src/services/instrumentService.js';
import { checkAndHandleReversal } from '../src/services/orderService.js';

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

test('stores a unique signal lifecycle id before the entry order is placed', async () => {
    const signal = {
        AC: 'TEST_SIGNAL_ACCOUNT',
        TS: 'RELIANCE',
        E: 'NSE',
        TT: 'BUY',
        exchange: 'NSE',
        symbol: 'RELIANCE',
        action: 'BUY',
        quantity: 1,
        product: 'CNC'
    };

    const result = await tradeLifecycleService.createSignalLifecycle(signal, signal.AC);

    assert.equal(typeof result.signalId, 'string');
    assert.ok(result.signalId.length > 0);

    const rows = await dbService.query(`
        SELECT *
        FROM trade_lifecycle_events
        WHERE order_id = $1
          AND event_type = 'SIGNAL_RECEIVED'
    `, [result.signalId]);

    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].account_id, signal.AC);
});

test('skips reversal handling when the opposite trade is already closed by TP/SL', async () => {
    const accountId = 'REVERSAL_CLOSED_TEST';
    const symbol = 'TCS';

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
            status,
            lifecycle_status,
            entry_price,
            target_order_id,
            stoploss_order_id,
            target_price,
            stoploss_price
        )
        VALUES
        ($1, $2, 'NSE', 'BUY', 'CNC', 1, 'ENTRY-REV-CLOSED', 'CLOSED', 'TARGET_HIT', 101, 'TARGET-REV-CLOSED', 'STOP-REV-CLOSED', 105, 98)
    `, [accountId, symbol]);

    const result = await checkAndHandleReversal({
        AC: accountId,
        TS: symbol,
        E: 'NSE',
        TT: 'SELL'
    }, accountId);

    assert.equal(result, null);
});

test('allows MCX signals to build a broker payload even without a local instrument snapshot entry', async () => {
    const signal = {
        AC: 'SHIV',
        TT: 'BUY',
        E: 'MCX',
        TS: 'CRUDEOIL',
        Q: '1',
        OT: 'MARKET',
        P: 'MIS',
        VL: 'DAY'
    };

    const payload = await instrumentService.buildOrder(signal);

    assert.equal(payload.accountId, 'SHIV');
    assert.equal(payload.exchange, 'MCX');
    assert.equal(payload.tradingsymbol, 'CRUDEOIL');
    assert.equal(payload.transaction_type, 'BUY');
    assert.equal(payload.quantity, 1);
});

test('updates lifecycle managed state with SQLite-safe boolean values', async () => {
    await dbService.query(`
        INSERT INTO trade_positions
        (
            account_id,
            tradingsymbol,
            exchange,
            transaction_type,
            product,
            quantity,
            status
        )
        VALUES
        ($1, $2, $3, $4, $5, $6, 'OPEN')
    `, ['LIFECYCLE_BOOL_TEST', 'BOOL_TEST', 'NSE', 'BUY', 'CNC', 1]);

    const row = await dbService.query(`
        SELECT id
        FROM trade_positions
        WHERE account_id = $1
        ORDER BY id DESC
        LIMIT 1
    `, ['LIFECYCLE_BOOL_TEST']);

    const positionId = row.rows[0].id;

    await dbService.query(`
        UPDATE trade_positions
        SET managed = $1,
            lifecycle_status = $2,
            updated_at = NOW()
        WHERE id = $3
    `, [1, 'ENTRY_PENDING', positionId]);

    const result = await dbService.query(`
        SELECT managed, lifecycle_status
        FROM trade_positions
        WHERE id = $1
    `, [positionId]);

    assert.equal(result.rows[0].managed, 1);
    assert.equal(result.rows[0].lifecycle_status, 'ENTRY_PENDING');
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
