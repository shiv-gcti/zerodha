import dotenv from 'dotenv';

dotenv.config();

export const ACCOUNTS = [
    
    {
        id: 'SHIV',
        userId: process.env.ZERODHA_SHIV_USER_ID,
        password: process.env.ZERODHA_SHIV_PASSWORD,
        totp: process.env.ZERODHA_SHIV_TOTP,
        apiKey: process.env.ZERODHA_SHIV_API_KEY || process.env.ZERODHA_API_KEY,
        apiSecret: process.env.ZERODHA_SHIV_API_SECRET || process.env.ZERODHA_API_SECRET
    }
];

