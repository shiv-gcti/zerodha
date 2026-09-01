import dbService from './src/services/dbService.js';
import kite from './src/config/kite.js';
import { ACCOUNTS } from './src/config/accounts.js';

const orig = dbService.query.bind(dbService);
dbService.query = async (...args) => {
  try {
    return await orig(...args);
  } catch (e) {
    console.log('SQL_FAIL');
    console.log(String(args[0]));
    console.log('PARAMS', JSON.stringify(args[1] || []));
    console.log('ERROR', e.message);
    throw e;
  }
};

ACCOUNTS.length = 0;
ACCOUNTS.push({ id: 'SHIV', apiKey: 'demo', apiSecret: 'demo' });

kite.getInstance = async () => ({
  getOrders: async () => [{
    order_id: '1',
    status: 'COMPLETE',
    tradingsymbol: 'TEST',
    exchange: 'NSE',
    transaction_type: 'BUY',
    quantity: 1,
    product: 'CNC',
    average_price: 100
  }]
});

try {
  const { default: positionService } = await import('./src/services/positionService.js');
  await positionService.create({
    accountId: 'SHIV',
    tradingsymbol: 'TEST',
    exchange: 'NSE',
    transaction_type: 'BUY',
    product: 'CNC',
    quantity: 1,
    targetPoints: 5,
    stopLossPoints: 3,
    exchangeToken: null
  }, 'ORD-ENTRY-1');

  const { default: tpSlService } = await import('./src/services/tpSlService.js');
  await tpSlService.handleOrderUpdate('SHIV', {
    order_id: 'ORD-ENTRY-1',
    status: 'COMPLETE',
    average_price: 100,
    tradingsymbol: 'TEST',
    exchange: 'NSE',
    transaction_type: 'BUY',
    quantity: 1,
    product: 'CNC'
  });
  console.log('DONE');
} catch (e) {
  console.error('TOP_LEVEL_ERR', e.stack || e.message);
  process.exit(1);
}
