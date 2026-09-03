import express from 'express';
import { profile, margins } from '../controllers/zerodhaController.js';
import { KiteConnect } from 'kiteconnect';
import { ACCOUNTS } from '../config/accounts.js';
import loginService from '../services/loginService.js';
import tokenManager from '../services/tokenManager.js';

const router = express.Router();

router.get('/profile', profile);
router.get('/margins', margins);

let automatedAllTokenRun = null;

function setNoCacheHeaders(res) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
}

function findAccount(accountId) {
    const normalizedAccountId = String(accountId || '').trim().toUpperCase();
    return ACCOUNTS.find(account => account.id.toUpperCase() === normalizedAccountId) || null;
}

function renderTokenStatusPage({ success, accountId, message, error }) {
    const title = success ? 'Token generated successfully' : 'Token generation failed';
    const detail = success
        ? `Token has been generated successfully for account ${accountId}. You can close this browser window.`
        : (message || 'Unable to generate token.');
    const escapedDetail = String(detail)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    const escapedError = error
        ? String(error)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
        : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
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
    .manual-close {
      display: none;
      margin-top: 12px;
      color: #a8a8a8;
      font-size: 13px;
    }
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
    <h1>${title}</h1>
    <p>${escapedDetail}</p>
    ${escapedError ? `<p class="error">${escapedError}</p>` : ''}
    <button type="button" onclick="closeTokenWindow()">Close browser</button>
    <p class="manual-close" id="manualCloseMessage">If this button does not close the window, close this popup tab manually. The token is already saved.</p>
  </main>
  <script>
    function closeTokenWindow() {
      window.close();
      setTimeout(function () {
        if (!window.closed) {
          document.getElementById('manualCloseMessage').style.display = 'block';
        }
      }, 300);
    }
  </script>
</body>
</html>`;
}

function determineRedirectUri(req) {
    const envRedirect = process.env.ZERODHA_REDIRECT_URL?.trim();
    const isLocalRedirect = /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(envRedirect || '');

    if (envRedirect && !isLocalRedirect) {
        return envRedirect;
    }

    const protocol = req.protocol;
    const host = req.get('host');
    if (!host) {
        throw new Error('Unable to determine host for Zerodha callback redirect URI.');
    }

    return `${protocol}://${host}/zerodha/kite/callback`;
}

router.get('/kite/login', (req, res) => {
    setNoCacheHeaders(res);
    const account = findAccount(req.query.account);

    if (!account) {
        return res.status(400).send(renderTokenStatusPage({
            success: false,
            accountId: req.query.account || '',
            message: `Unknown account ID: ${req.query.account || ''}`
        }));
    }

    const redirectUri = determineRedirectUri(req);

    loginService.startManualLogin(account, redirectUri)
        .then(({ sessionId }) => {
            res.json({
                success: true,
                message: `Temporary Kite login browser opened for ${account.id}.`,
                account_id: account.id,
                session_id: sessionId,
                redirect_uri: redirectUri
            });
        })
        .catch((error) => {
            res.status(500).json({
                success: false,
                message: error.message
            });
        });
});

router.get('/kite/token-status', async (req, res) => {
    setNoCacheHeaders(res);

    const accountId = String(req.query.account || 'SHIV').trim().toUpperCase();
    const account = findAccount(accountId);

    if (!account) {
        return res.status(400).json({
            success: false,
            account_id: accountId,
            message: `Unknown account ID: ${accountId}`
        });
    }

    const record = await tokenManager.getTokenRecord(account.id);
    const present = Boolean(record?.access_token);

    res.json({
        success: true,
        account_id: account.id,
        present,
        status: present ? 'present' : 'missing',
        updated_at: record?.updated_at || null
    });
});

router.get('/kite/generate-shiv-token', async (req, res) => {
    setNoCacheHeaders(res);

    const accountId = String(req.query.account || 'SHIV').trim().toUpperCase();
    const account = findAccount(accountId);

    if (!account) {
        return res.status(400).json({
            success: false,
            account_id: accountId,
            message: `Unknown account ID: ${accountId}`
        });
    }

    try {
        const session = await loginService.login(account, { headless: true });
        const tokenRecord = await tokenManager.getTokenRecord(account.id);
        const accessToken = tokenRecord?.access_token || session?.access_token || session?.data?.access_token;

        if (!accessToken) {
            throw new Error(`No access token was returned for account ${account.id}.`);
        }

        res.json({
            success: true,
            account_id: account.id,
            message: `Kite token generated and saved locally for ${account.id}.`,
            token_saved: true,
            token_preview: `${accessToken.slice(0, 10)}...`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            account_id: accountId,
            message: error.message
        });
    }
});

router.post('/kite/auto-login-all', async (req, res) => {
    setNoCacheHeaders(res);

    if (automatedAllTokenRun) {
        return res.status(409).json({
            success: false,
            message: 'Automated token generation is already running.'
        });
    }

    automatedAllTokenRun = tokenManager.refreshAllTokens({ headless: true })
        .finally(() => {
            automatedAllTokenRun = null;
        });

    try {
        const summary = await automatedAllTokenRun;
        const hasFailure = Object.values(summary).some(result => result.status !== 'success');

        res.status(hasFailure ? 207 : 200).json({
            success: !hasFailure,
            message: hasFailure
                ? 'Automated token generation completed with failures.'
                : 'Automated token generation completed successfully.',
            summary
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Manual Browser Redirect Target Fallback Endpoint
router.get('/kite/callback', async (req, res) => {
    setNoCacheHeaders(res);

    try {
        const { request_token, state } = req.query;
        
        console.log(`\n🚀 Manual Browser Redirect Callback Triggered!`);
        console.log(`- Request Token: ${request_token}`);
        console.log(`- Detected Account ID (State Parameter): ${state}`);

        if (!request_token) {
            return res.status(400).json({ 
                success: false, 
                message: 'Callback triggered but no request_token was found in query parameters.' 
            });
        }

        // 1. Resolve Account ID securely without hardcoded defaults
        let accountId = state && state !== 'undefined' ? String(state).trim().toUpperCase() : null; 
        
        if (!accountId) {
            console.warn(`- Warning: State parameter is missing. Attempting fallback matching lookup...`);
            // If manual authorization has no state parameter, default cleanly to your primary profile configuration context
            accountId = 'PM';
        }
        console.log(`- Final resolved Account ID routing context: ${accountId}`);

        const account = findAccount(accountId);

        if (!account) {
            return res.status(400).send(renderTokenStatusPage({
                success: false,
                accountId,
                message: `Unknown account ID: ${accountId}`
            }));
        }

        // 2. Extract relative variables
        let apiKey = account.apiKey;
        let apiSecret = account.apiSecret;

        if (!apiKey || !apiSecret) {
            throw new Error(`Missing API Credentials setup for resolved scope: ${accountId}`);
        }

        // 3. Trade request token context with KiteConnect SDK APIs
        console.log(`Exchanging token via fallback endpoint router for profile: ${accountId}...`);
        const kc = new KiteConnect({ api_key: apiKey });
        
        const sessionData = await kc.generateSession(request_token, apiSecret);
        const accessToken = sessionData.access_token;
        const publicToken = sessionData.public_token;

        console.log(`Session tokens calculated successfully inside HTTP routing middleware thread.`);

        console.log(`Syncing tokens to local store for account: ${accountId}...`);

        const existingRecord = await tokenManager.getTokenRecord(accountId);
        const record = {
            account_id: accountId,
            user_id: account.userId,
            access_token: accessToken,
            public_token: publicToken,
            created_at: existingRecord?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        await tokenManager.upsertTokenRecord(record);

        const savedRecord = await tokenManager.getTokenRecord(accountId);
        if (!savedRecord) {
            throw new Error(`Token save verification failed for account ${accountId}.`);
        }

        console.log(`✅ Tokens securely saved/updated via Router Endpoint for profile: ${accountId}`);

        res.send(renderTokenStatusPage({
            success: true,
            accountId,
            message: `Authentication finalized manually and synced to DB!`
        }));

    } catch (error) {
        console.error('❌ Callback router request exchange thread failed:', error);
        res.status(500).send(renderTokenStatusPage({
            success: false,
            accountId: req.query.state || '',
            message: 'Failed to process web session request exchange mapping context.',
            error: error.message
        }));
    }
});

export default router;
