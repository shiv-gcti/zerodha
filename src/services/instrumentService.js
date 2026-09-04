import fs from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import csv from 'csv-parser';
import db from './dbService.js';
import { normalizeBrokerProduct, resolveBrokerTradingsymbol } from '../utils/orderPayload.js';

let instrumentCsvCache = null;
let instrumentCsvPromise = null;

class InstrumentService {

    async getInstrument(tradingSymbol, exchange = null) {
        const values = [tradingSymbol];
        const exchangeFilter = exchange ? 'AND exchange = $2' : '';

        if (exchange) {
            values.push(exchange);
        }

        const result = await db.query(
            `
            SELECT
                tradingsymbol,
                exchange,
                exchange_token,
                instrument_token,
                lot_size,
                instrument_type,
                segment,
                expiry,
                strike
            FROM zerodha_instruments
            WHERE tradingsymbol = $1
            ${exchangeFilter}

            ORDER BY
                CASE exchange
                    WHEN 'NSE' THEN 1
                    WHEN 'BSE' THEN 2
                    ELSE 3
                END
            LIMIT 1
            `,
            values
        );

        if (result.rows.length > 0) {
            return result.rows[0];
        }

        const fallbackResult = await db.query(
            `
            SELECT
                symbol AS tradingsymbol,
                exch_seg AS exchange,
                NULL::BIGINT AS exchange_token,
                symbol_token::BIGINT AS instrument_token,
                lotsize AS lot_size,
                instrumenttype AS instrument_type,
                NULL::TEXT AS segment,
                expiry,
                strike
            FROM angel_instruments
            WHERE symbol = $1
            OR name = $1
            ORDER BY updated_at DESC
            LIMIT 1
            `,
            [tradingSymbol]
        );

        if (fallbackResult.rows.length > 0) {
            const fallback = fallbackResult.rows[0];
            return {
                ...fallback,
                tradingsymbol: fallback.tradingsymbol || fallback.symbol || tradingSymbol,
                exchange: fallback.exchange || 'NSE'
            };
        }

        const csvInstrument = await this.getInstrumentFromCsv(tradingSymbol, exchange);
        if (csvInstrument) {
            return csvInstrument;
        }

        return null;
    }

    normalizeInstrumentLookupKey(value) {
        return String(value ?? '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
    }

    async loadInstrumentCsvRows() {
        if (instrumentCsvCache) {
            return instrumentCsvCache;
        }

        if (instrumentCsvPromise) {
            return await instrumentCsvPromise;
        }

        instrumentCsvPromise = new Promise((resolve, reject) => {
            const filePath = path.resolve(process.cwd(), 'data', 'instruments.csv');
            const rows = [];

            if (!fs.existsSync(filePath)) {
                resolve([]);
                return;
            }

            const stream = createReadStream(filePath)
                .pipe(csv())
                .on('data', (row) => rows.push(row))
                .on('end', () => {
                    instrumentCsvCache = rows;
                    resolve(rows);
                })
                .on('error', (error) => {
                    reject(error);
                });

            stream.on('error', (error) => {
                reject(error);
            });
        });

        try {
            return await instrumentCsvPromise;
        } finally {
            instrumentCsvPromise = null;
        }
    }

    buildInstrumentLookupCandidates(normalizedSymbol) {
        const normalized = String(normalizedSymbol ?? '').trim().toUpperCase();
        if (!normalized) {
            return [];
        }

        const candidates = new Set([normalized]);
        const suffixPatterns = [
            /FUT$/,
            /CE$/,
            /PE$/,
            /(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[0-9]{2,}$/i,
            /[0-9]{2,}$/
        ];

        suffixPatterns.forEach((pattern) => {
            const match = normalized.match(pattern);
            if (match) {
                const withoutSuffix = normalized.replace(pattern, '');
                if (withoutSuffix) {
                    candidates.add(withoutSuffix);
                }
            }
        });

        const withoutExchangeSuffix = normalized.replace(/(FUT|CE|PE)$/i, '');
        if (withoutExchangeSuffix) {
            candidates.add(withoutExchangeSuffix);
        }

        return Array.from(candidates);
    }

    async getInstrumentFromCsv(tradingSymbol, exchange = null) {
        const normalizedSymbol = String(tradingSymbol ?? '').trim();
        if (!normalizedSymbol) {
            return null;
        }

        const rows = await this.loadInstrumentCsvRows();
        const normalizedExchange = exchange ? String(exchange).trim().toUpperCase() : null;
        const lookupKeys = this.buildInstrumentLookupCandidates(normalizedSymbol);

        const exactCandidates = rows.filter((row) => {
            const symbol = String(row?.tradingsymbol || row?.symbol || '').trim();
            const rowExchange = String(row?.exchange || '').trim().toUpperCase();
            const rowLookupKey = this.normalizeInstrumentLookupKey(symbol);
            const rowNameLookupKey = this.normalizeInstrumentLookupKey(row?.name || '');
            const sameExchange = !normalizedExchange || !rowExchange || rowExchange === normalizedExchange;
            const symbolMatch = lookupKeys.some((lookupKey) => rowLookupKey === this.normalizeInstrumentLookupKey(lookupKey) || rowNameLookupKey === this.normalizeInstrumentLookupKey(lookupKey));
            return sameExchange && symbolMatch;
        });

        const selectedRow = exactCandidates[0] || rows.find((row) => {
            const symbol = String(row?.tradingsymbol || row?.symbol || '').trim();
            const rowExchange = String(row?.exchange || '').trim().toUpperCase();
            const rowLookupKey = this.normalizeInstrumentLookupKey(symbol);
            const rowNameLookupKey = this.normalizeInstrumentLookupKey(row?.name || '');
            const sameExchange = !normalizedExchange || !rowExchange || rowExchange === normalizedExchange;
            const symbolMatch = lookupKeys.some((lookupKey) => {
                const normalizedLookupKey = this.normalizeInstrumentLookupKey(lookupKey);
                return rowLookupKey.includes(normalizedLookupKey) || normalizedLookupKey.includes(rowLookupKey) || rowNameLookupKey.includes(normalizedLookupKey) || normalizedLookupKey.includes(rowNameLookupKey);
            });
            return sameExchange && symbolMatch;
        });

        if (selectedRow) {
            return {
                tradingsymbol: selectedRow.tradingsymbol || selectedRow.symbol || tradingSymbol,
                exchange: selectedRow.exchange || (normalizedExchange || 'NSE'),
                exchange_token: selectedRow.exchange_token ?? null,
                instrument_token: selectedRow.instrument_token ?? null,
                lot_size: selectedRow.lot_size ?? null,
                instrument_type: selectedRow.instrument_type ?? null,
                segment: selectedRow.segment ?? null,
                source: 'csv-fallback'
            };
        }

        const optionLike = /[0-9]{2,}[A-Z]+(CE|PE)$/i.test(normalizedSymbol);
        if (!optionLike) {
            return null;
        }

        const baseRoot = normalizedSymbol.replace(/(CE|PE)$/i, '');
        const optionSuffix = normalizedSymbol.endsWith('CE') ? 'CE' : 'PE';
        const fallbackRows = rows.filter((row) => {
            const symbol = String(row?.tradingsymbol || row?.symbol || '').trim();
            const rowExchange = String(row?.exchange || '').trim().toUpperCase();
            const rowLookupKey = this.normalizeInstrumentLookupKey(symbol);
            const sameExchange = !normalizedExchange || !rowExchange || rowExchange === normalizedExchange;
            const hasSameBase = rowLookupKey.includes(baseRoot) || baseRoot.includes(rowLookupKey);
            const hasSuffix = rowLookupKey.endsWith(optionSuffix.toUpperCase());
            return sameExchange && hasSameBase && hasSuffix;
        });

        const fallbackRow = fallbackRows[0];
        if (!fallbackRow) {
            return null;
        }

        return {
            tradingsymbol: fallbackRow.tradingsymbol || fallbackRow.symbol || tradingSymbol,
            exchange: fallbackRow.exchange || (normalizedExchange || 'NSE'),
            exchange_token: fallbackRow.exchange_token ?? null,
            instrument_token: fallbackRow.instrument_token ?? null,
            lot_size: fallbackRow.lot_size ?? null,
            instrument_type: fallbackRow.instrument_type ?? null,
            segment: fallbackRow.segment ?? null,
            source: 'csv-expiry-fallback'
        };
    }

    async getLotSize(tradingSymbol, exchange = null) {
        const instrument = await this.getInstrument(tradingSymbol, exchange);
        if (!instrument?.lot_size) {
            return 1;
        }
        return Number(instrument.lot_size);
    }

    async calculateQuantity(tradingSymbol, lots, exchange = null) {
        const lotSize = await this.getLotSize(tradingSymbol, exchange);

        return {
            lots: Number(lots),
            lotSize,
            quantity: Number(lots) * lotSize
        };
    }

async buildOrder(signal) {

    const normalizedSignal = {
        ...signal,
        TT: signal.TT || signal.action,
        TS: signal.TS || signal.symbol,
        Q: signal.Q || signal.quantity,
        E: signal.E || signal.exchange,
        TP: signal.TP ?? signal.tp ?? signal.target,
        SL: signal.SL ?? signal.sl ?? signal.stoploss ?? signal.stop_loss
    };

    if (!normalizedSignal.TT) {
        throw new Error('TT is required');
    }

    if (!normalizedSignal.TS) {
        throw new Error('TS is required');
    }

    if (!normalizedSignal.Q) {
        throw new Error('Q is required');
    }

if (!normalizedSignal.AC) {
    throw new Error('AC is required');
}

    const allowedAccounts = ['PM', 'PDM', 'PSM', 'SHIV'];

    if (
        normalizedSignal.AC &&
        !allowedAccounts.includes(normalizedSignal.AC)
    ) {
        throw new Error(`Invalid account: ${normalizedSignal.AC}`);
    }

        const exchange = normalizedSignal.E
            ? String(normalizedSignal.E).trim().toUpperCase()
            : null;

        if (exchange === 'MCX' && /[0-9]{2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/i.test(normalizedSignal.TS) === false) {
            throw new Error(`Invalid MCX futures symbol ${normalizedSignal.TS}; use a valid month code such as FEB, NOV, or DEC.`);
        }

        const instrument = await this.getInstrument(normalizedSignal.TS, exchange);
        const fallbackInstrument = instrument || {
            exchange: exchange || 'NSE',
            tradingsymbol: normalizedSignal.TS,
            exchange_token: null,
            instrument_token: null,
            lot_size: null,
            instrument_type: null,
            segment: null,
            source: 'signal-fallback'
        };

        if (!instrument) {
            console.warn(`[INSTRUMENT] Falling back to raw symbol payload for ${normalizedSignal.TS} on ${exchange || 'NSE'} because the local instrument snapshot is missing.`);
        }

        const quantityData = await this.calculateQuantity(
            normalizedSignal.TS,
            normalizedSignal.Q,
            exchange
        );

return {
    accountId: normalizedSignal.AC,

    exchange: fallbackInstrument.exchange,
    tradingsymbol: resolveBrokerTradingsymbol(normalizedSignal.TS, fallbackInstrument),
    exchangeToken: fallbackInstrument.exchange_token ?? null,
    instrumentToken: fallbackInstrument.instrument_token ?? null,
    transaction_type: String(normalizedSignal.TT).toUpperCase(),
    quantity: quantityData.quantity || Number(normalizedSignal.Q),
    order_type: normalizedSignal.OT || 'MARKET',
    product: normalizeBrokerProduct(normalizedSignal.P, 'NRML'),
    validity: normalizedSignal.VL || 'DAY',

    targetPoints: normalizedSignal.TP || '',
    stopLossPoints: normalizedSignal.SL || '',
    price: normalizedSignal.PR || null,
};

}
 }

export default new InstrumentService();
