import fs from 'fs';
import path from 'path';
import { SmartAPI } from 'smartapi-javascript';
import { authenticator } from 'otplib';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'local-store');
fs.mkdirSync(DATA_DIR, { recursive: true });

function readTable(tableName) {
    const filePath = path.join(DATA_DIR, `${tableName}.json`);
    if (!fs.existsSync(filePath)) return [];
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeTable(tableName, rows) {
    const filePath = path.join(DATA_DIR, `${tableName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
}

class AngelAuthService {
    constructor() {
        this.smartApi = new SmartAPI({
            api_key: process.env.ANGEL_API_KEY
        });
    }

    async generateSession() {
        try {
            console.log('🔐 Generating Angel session...');

            const totp = authenticator.generate(process.env.ANGEL_TOTP_SECRET);
            const response = await this.smartApi.generateSession(
                process.env.ANGEL_CLIENT_CODE,
                process.env.ANGEL_PASSWORD,
                totp
            );

            if (!response || !response.data || !response.data.jwtToken) {
                throw new Error(`Angel login failed: ${JSON.stringify(response)}`);
            }

            const jwtToken = response?.data?.jwtToken;
            const refreshToken = response?.data?.refreshToken;
            const feedToken = response?.data?.feedToken;

            if (!jwtToken) {
                throw new Error('jwtToken missing in Angel response');
            }

            const tokenData = {
                id: 1,
                access_token: jwtToken,
                refresh_token: refreshToken || null,
                feed_token: feedToken || null,
                jwt_token: jwtToken,
                generated_at: new Date().toISOString()
            };

            const rows = readTable('angel_tokens');
            const existingIndex = rows.findIndex((row) => row.id === 1);

            if (existingIndex >= 0) {
                rows[existingIndex] = { ...rows[existingIndex], ...tokenData };
            } else {
                rows.push(tokenData);
            }

            writeTable('angel_tokens', rows);
            console.log('✅ Angel session generated successfully');
            return tokenData;
        } catch (err) {
            console.error('❌ Angel authentication failed:', err.message);
            throw err;
        }
    }

    async getLatestToken() {
        const rows = readTable('angel_tokens').sort((a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0));
        return rows[0] || null;
    }
}

export default new AngelAuthService();