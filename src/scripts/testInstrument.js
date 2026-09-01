import instrumentService from '../services/instrumentService.js';
import dotenv from 'dotenv';

dotenv.config();

console.log('Local SQLite DB:', require('path').join(process.cwd(), 'data', 'app-local.db'));

const signal = {
    TT: 'BUY',
    E: 'NFO',
    TS: 'NIFTY2660221200PE',
    Q: '1',
    OT: 'MARKET',
    P: 'NRML',
    VL: 'DAY'
};

try {
    const order = await instrumentService.buildOrder(signal);

    console.log(order);

} catch (err) {
    console.error(err.message);
}