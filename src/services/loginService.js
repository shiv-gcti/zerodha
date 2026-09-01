import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import crypto from 'crypto';
import { KiteConnect } from 'kiteconnect';
import logger from './logger.js';
import tokenManager from './tokenManager.js';
import { refreshInstrumentCsvIfNeeded } from '../jobs/instrumentSyncJob.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config();

// Native Base32 decoding method to ensure cross-platform runtime reliability
function decodeBase32(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = base32.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = 0;
    let value = 0;
    const buffer = [];

    for (let i = 0; i < cleaned.length; i++) {
        const idx = alphabet.indexOf(cleaned[i]);
        if (idx === -1) throw new Error('Invalid Base32 character: ' + cleaned[i]);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            buffer.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(buffer);
}

// Native Time-Based One-Time Password (TOTP) engine
function generateTOTP(secretBase32) {
    const key = decodeBase32(secretBase32);
    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);

    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter), 0);

    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) << 8) |
                 (hmac[offset + 3] & 0xff);

    const token = code % 1000000;
    return token.toString().padStart(6, '0');
}

class ZerodhaLoginService {
    constructor() {
        this.debugDir = './debug-logs';
        if (!fs.existsSync(this.debugDir)) {
            fs.mkdirSync(this.debugDir);
        }
        this.manualSessions = new Map();
    }

    async getChromeExecutablePath() {
        const isProduction = (process.env.NODE_ENV === 'production' || process.env.RENDER) && process.platform !== 'win32';

        if (isProduction) {
            return await chromium.executablePath();
        }

        return process.platform === 'win32'
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            : '/usr/bin/google-chrome';
    }

    buildLoginUrl(account, redirectUri) {
        const resolvedRedirectUri = redirectUri || process.env.ZERODHA_REDIRECT_URL;
        if (!resolvedRedirectUri) {
            throw new Error('ZERODHA_REDIRECT_URL is not configured and no redirect URI was supplied.');
        }

        const loginUrl = new URL('https://kite.trade/connect/login');
        loginUrl.searchParams.set('v', '3');
        loginUrl.searchParams.set('api_key', account.apiKey);
        loginUrl.searchParams.set('redirect_uri', resolvedRedirectUri);
        loginUrl.searchParams.set('state', account.id);
        loginUrl.searchParams.set('_', String(Date.now()));
        return loginUrl.toString();
    }

    renderManualStatusPage({ success, accountId, message, error }) {
        const title = success ? 'Token generated successfully' : 'Token generation failed';
        const detail = success
            ? `Token has been generated successfully for account ${accountId}. You can close this temporary browser.`
            : (message || 'Unable to generate token.');
        const escapeHtml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background: #090909;
      color: #f2f2f2;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    }
    main {
      width: min(520px, calc(100% - 32px));
      border: 1px solid #303030;
      border-radius: 12px;
      background: #141414;
      padding: 28px;
      box-shadow: 0 18px 50px rgba(0,0,0,.42);
    }
    h1 { margin: 0; font-size: 24px; line-height: 1.2; }
    p { margin: 12px 0 0; color: #a8a8a8; line-height: 1.5; }
    .error { color: #f87171; }
    button {
      min-height: 44px;
      margin-top: 22px;
      padding: 11px 16px;
      border: 0;
      border-radius: 8px;
      background: #14b87a;
      color: #03130d;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <button type="button" onclick="closeManualTokenBrowser()">Close browser</button>
  </main>
  <script>
    function closeManualTokenBrowser() {
      if (window.closeManualTokenBrowserNative) {
        window.closeManualTokenBrowserNative();
      } else {
        window.close();
      }
    }
  </script>
</body>
</html>`;
    }

    async startManualLogin(account, redirectUri) {
        if (!account?.id || !account.apiKey || !account.apiSecret) {
            throw new Error(`Missing Zerodha API credentials for account ${account?.id || 'UNKNOWN'}`);
        }

        const sessionId = `${account.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        if (this.manualSessions.has(account.id)) {
            throw new Error(`Manual login is already running for account ${account.id}. Close that window or wait for it to finish.`);
        }

        this.manualSessions.set(account.id, { sessionId, status: 'starting' });
        this.runManualLoginSession(account, sessionId, redirectUri).catch((error) => {
            logger.error(`Manual Zerodha login failed for ${account.id}:`, error.message);
        });

        return { sessionId };
    }

    async runManualLoginSession(account, sessionId, redirectUri) {
        let browser = null;
        let page = null;
        const userDataDir = path.join(os.tmpdir(), `kite-manual-${account.id}-${Date.now()}`);

        try {
            this.manualSessions.set(account.id, { sessionId, status: 'opening' });

            browser = await puppeteer.launch({
                executablePath: await this.getChromeExecutablePath(),
                headless: false,
                userDataDir,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--new-window'
                ],
                defaultViewport: null
            });

            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
            await page.exposeFunction('closeManualTokenBrowserNative', async () => {
                await browser.close().catch(() => {});
            });

            let interceptedToken = null;
            let tokenHandled = false;

            await page.setRequestInterception(true);
            page.on('request', async (request) => {
                const url = request.url();

                if (!url.includes('request_token=')) {
                    request.continue().catch(() => {});
                    return;
                }

                request.abort().catch(() => {});

                if (tokenHandled) return;
                tokenHandled = true;

                try {
                    const urlParams = new URLSearchParams(new URL(url).search);
                    interceptedToken = urlParams.get('request_token');

                    if (!interceptedToken) {
                        throw new Error('Kite redirected without request_token.');
                    }

                    this.manualSessions.set(account.id, { sessionId, status: 'saving' });
                    await this.generateAccessToken(account, interceptedToken);

                    this.manualSessions.set(account.id, { sessionId, status: 'success' });
                    await page.setRequestInterception(false).catch(() => {});
                    await page.setContent(this.renderManualStatusPage({
                        success: true,
                        accountId: account.id
                    }));
                } catch (error) {
                    this.manualSessions.set(account.id, { sessionId, status: 'failed', error: error.message });
                    await page.setContent(this.renderManualStatusPage({
                        success: false,
                        accountId: account.id,
                        error: error.message
                    })).catch(() => {});
                }
            });

            await page.goto(this.buildLoginUrl(account, redirectUri), { waitUntil: 'load', timeout: 60000 });
            this.manualSessions.set(account.id, { sessionId, status: 'waiting_for_user' });
        } catch (error) {
            this.manualSessions.set(account.id, { sessionId, status: 'failed', error: error.message });

            if (page && !page.isClosed()) {
                await page.setContent(this.renderManualStatusPage({
                    success: false,
                    accountId: account.id,
                    error: error.message
                })).catch(() => {});
                return;
            }

            if (browser) {
                await browser.close().catch(() => {});
            }

            throw error;
        } finally {
            const cleanup = async () => {
                this.manualSessions.delete(account.id);
                await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
            };

            if (browser) {
                browser.once('disconnected', cleanup);
            } else {
                await cleanup();
            }
        }
    }

    async takeScreenshot(page, stage) {
        try {
            if (page.isClosed()) return;
            const screenshotPath = path.join(this.debugDir, `debug-stage-${stage}-${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (err) {
            // Suppress non-critical screenshot writing warnings
        }
    }

    async getRequestToken(account, options = {}) {
        logger.info(`Starting Zerodha automated login loop for account ID: "${account.id}"...`);
        
        const isProduction = (process.env.NODE_ENV === 'production' || process.env.RENDER) && process.platform !== 'win32';
        const headless = options.headless ?? (isProduction ? chromium.headless : false);
        
        const launchOptions = {
            executablePath: await this.getChromeExecutablePath(),
            headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ],
            defaultViewport: isProduction ? chromium.defaultViewport : { width: 1280, height: 800 }
        };

        const browser = await puppeteer.launch(launchOptions);
        try {
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

            const redirectUri = process.env.ZERODHA_REDIRECT_URL;
            let loginUrl = `https://kite.trade/connect/login?v=3&api_key=${account.apiKey}&redirect_uri=${encodeURIComponent(redirectUri)}`;
            if (account.id) {
                loginUrl += `&state=${account.id}`;
            }
            
            await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 });

            // 1. Enter User ID
            await page.waitForSelector('#userid', { visible: true, timeout: 15000 });
            await page.type('#userid', account.userId, { delay: 100 });
            await page.click('button[type="submit"]');

            // 2. Enter Password
            await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 });
            await page.type('input[type="password"]', account.password, { delay: 100 });
            await page.click('button[type="submit"]');

            // 3. 2FA TOTP Input Management
            const totpTargetSelector = 'input[label="External TOTP"], #totp, .su-input-group input, input[type="text"]';
            await page.waitForSelector(totpTargetSelector, { visible: true, timeout: 15000 });
            
            const secret = account.totp.trim();
            const otp = generateTOTP(secret);
            logger.info(`Generated OTP successfully for ${account.id}: ${otp}`);

            const totpInput = await page.$(totpTargetSelector);
            await totpInput.focus();
            
            // Clear input buffer thoroughly using keyboard emulation
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await new Promise(resolve => setTimeout(resolve, 200));

            // CRITICAL STEP: Initialize Request Interception BEFORE typing the final OTP strings.
            // This walls off the network connection so when Zerodha tries to auto-submit on the 
            // 6th character, the browser intercepts and blocks it from hitting Express on Port 3000.
            let interceptedToken = null;
            await page.setRequestInterception(true);

            page.on('request', (request) => {
                const url = request.url();
                if (url.includes('request_token=')) {
                    try {
                        const urlParams = new URLSearchParams(new URL(url).search);
                        interceptedToken = urlParams.get('request_token');
                        if (interceptedToken) {
                            logger.info(`🎯 [SUCCESS] Intercepted request_token mid-air for account: ${account.id}`);
                        }
                    } catch (err) {}
                    // Abort request immediately to isolate execution from local Express routers
                    request.abort().catch(() => {});
                } else {
                    request.continue().catch(() => {});
                }
            });

            // Type the OTP (triggers the auto-submission)
            await totpInput.type(otp, { delay: 150 });

            // Poll the internal instance trace variable until token is registered
            const startPolling = Date.now();
            while (Date.now() - startPolling < 15000) {
                if (interceptedToken) break;
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            if (!interceptedToken) {
                throw new Error(`Token capture timeout out. Page location: ${page.url()}`);
            }

            await page.setRequestInterception(false).catch(() => {});
            return interceptedToken;

        } catch (error) {
            logger.error(`Error during Zerodha automated authentication sequence for account: ${account.id}`, error);
            throw error;
        } finally {
            if (browser) {
                try {
                    // Safe browser teardown wrapped to shield against operating system taskkill PID exceptions
                    await browser.close();
                    logger.info('Browser context cleanly terminated.');
                } catch (closeErr) {
                    logger.warn('Suppressed non-critical browser termination trace warnings.');
                }
            }
        }
    }

    /**
     * Direct database upsert engine wrapped into the session exchange execution step
     */
    async generateAccessToken(account, requestToken) {
        const kc = new KiteConnect({ api_key: account.apiKey });

        try {
            logger.info(`Exchanging isolated request token for session: ${account.id}...`);
            const response = await kc.generateSession(requestToken, account.apiSecret);
            logger.info(`🎉 Session successfully created for account: ${account.id}!`);
            
            logger.info(`Saving tokens locally for account: ${account.id}...`);
            await tokenManager.upsertTokenRecord({
                account_id: account.id,
                user_id: account.userId,
                access_token: response.access_token,
                public_token: response.public_token,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
            logger.info(`✅ Tokens securely saved/updated locally for: ${account.id}`);

            try {
                await refreshInstrumentCsvIfNeeded();
            } catch (syncError) {
                logger.warn(`Instrument CSV refresh after login skipped for ${account.id}: ${syncError?.message || syncError}`);
            }

            return response;
        } catch (error) {
            logger.error(`Session negotiation or DB persistence failed for ${account.id}:`, error.message);
            throw error;
        }
    }

    async login(account, options = {}) {
        const requestToken = await this.getRequestToken(account, options);
        return await this.generateAccessToken(account, requestToken);
    }
}

export default new ZerodhaLoginService();
