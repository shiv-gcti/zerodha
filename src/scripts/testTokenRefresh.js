import dotenv from 'dotenv';
import tokenManager from '../services/tokenManager.js';

dotenv.config();

const runTest = async () => {
    try {
        console.log('🚀 Starting token test...');

        // test only one account first (IMPORTANT)
        const result = await tokenManager.refreshAllTokens();

        console.log('🎉 Token refresh completed');
        console.log(result);

    } catch (err) {
        console.error('❌ Test failed:', err.message);
    }
};

runTest();