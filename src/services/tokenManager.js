import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import loginService from './loginService.js';
import { ACCOUNTS } from '../config/accounts.js';
import logger from './logger.js';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'local-store');
fs.mkdirSync(DATA_DIR, { recursive: true });

function getTablePath(tableName) {
    return path.join(DATA_DIR, `${String(tableName).trim()}.json`);
}

function readTable(tableName) {
    const filePath = getTablePath(tableName);
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const json = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeTable(tableName, rows) {
    const filePath = getTablePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
}

class TokenManager {
    constructor() {
        this.missingTokenRetryAt = new Map();
        this.missingTokenRetryMs = 60000;
    }

    async refreshAllTokens(options = {}) {
        const executionSummary = {};

        for (const account of ACCOUNTS) {
            try {
                logger.info(`Refreshing token for ${account.id}`);
                await loginService.login(account, options);
                logger.info(`Token verification workflow completed for ${account.id}`);
                executionSummary[account.id] = { status: 'success' };
            } catch (err) {
                logger.error(`Failed for ${account.id}:`, err.message);
                executionSummary[account.id] = { status: 'failed', error: err.message };
            }
        }

        return executionSummary;
    }

    async getTokenRecord(accountId) {
        const rows = readTable('zerodha_tokens').filter((row) => row.account_id === accountId);
        if (!rows.length) {
            return null;
        }

        rows.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        return rows[0];
    }

    async upsertTokenRecord(record) {
        const rows = readTable('zerodha_tokens');
        const index = rows.findIndex((row) => row.account_id === record.account_id);
        const nextRecord = {
            ...record,
            updated_at: new Date().toISOString()
        };

        if (index >= 0) {
            rows[index] = { ...rows[index], ...nextRecord };
        } else {
            rows.push({
                ...nextRecord,
                created_at: new Date().toISOString()
            });
        }

        writeTable('zerodha_tokens', rows);
        return nextRecord;
    }

    async getToken(accountId) {
        const existingRecord = await this.getTokenRecord(accountId);
        if (existingRecord?.access_token) {
            return existingRecord.access_token;
        }

        const account = ACCOUNTS.find((candidate) => candidate.id === accountId);
        if (!account) {
            return null;
        }

        const retryAt = this.missingTokenRetryAt.get(accountId) || 0;
        const now = Date.now();
        if (retryAt > now) {
            logger.warn(`Skipping Zerodha token refresh for ${accountId} until ${new Date(retryAt).toISOString()}; no valid local token present.`);
            return null;
        }

        try {
            logger.info(`No local Zerodha token found for ${accountId}; attempting fresh login...`);
            const session = await loginService.login(account, { headless: true });
            const accessToken = session?.access_token || session?.data?.access_token;
            if (!accessToken) {
                this.missingTokenRetryAt.set(accountId, Date.now() + this.missingTokenRetryMs);
                logger.warn(`Fresh login for ${accountId} did not return an access token.`);
                return null;
            }

            await this.upsertTokenRecord({
                account_id: account.id,
                user_id: account.userId,
                access_token: accessToken,
                public_token: session?.public_token || session?.data?.public_token || null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            this.missingTokenRetryAt.delete(accountId);
            return accessToken;
        } catch (error) {
            this.missingTokenRetryAt.set(accountId, Date.now() + this.missingTokenRetryMs);
            logger.error(`Failed to bootstrap Zerodha token for ${accountId}:`, error?.message || error);
            return null;
        }
    }
}

export default new TokenManager();
