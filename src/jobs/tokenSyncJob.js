import cron from 'node-cron';
import tokenManager from '../services/tokenManager.js';
import logger from '../services/logger.js';

const ACCOUNTS = ['PM', 'PDM', 'PSM' ,'SHIV'];

const runTokenRefresh = async () => {

    logger.info('🚀 Starting daily Zerodha token refresh...');

    await tokenManager.refreshAllTokens();

    logger.info('🎉 All token refresh completed');
};

export const startTokenSyncJob = () => {

    // 06:10 AM IST daily (after instrument sync)
    cron.schedule('10 6 * * *', async () => {
        await runTokenRefresh();
    }, {
        timezone: 'Asia/Kolkata'
    });

    logger.info('📅 Token Sync Job scheduled at 06:10 AM IST');
};
