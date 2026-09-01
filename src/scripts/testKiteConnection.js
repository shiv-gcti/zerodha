import kite from '../config/kite.js';
import { ACCOUNTS } from '../config/accounts.js';

try {

    const kc = await kite.getInstance('PM');

    const profile = await kc.getProfile();

    console.log(profile);
    console.log(ACCOUNTS);

} catch (err) {

    console.error(err);

}