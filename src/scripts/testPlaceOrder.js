import kite from '../config/kite.js';

const kc = await kite.getInstance('PM');

console.log(await kc.getMargins());