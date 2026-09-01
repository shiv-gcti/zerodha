import kite from '../config/kite.js';

const kc = await kite.getInstance('PM');

const orders = await kc.getOrders();

console.log(JSON.stringify(
    orders.slice(-5),
    null,
    2
));