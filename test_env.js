
require('dotenv').config();
console.log('PUBLIC_KEY:', process.env.VAPID_PUBLIC_KEY ? 'FOUND' : 'MISSING');
console.log('LENGTH:', (process.env.VAPID_PUBLIC_KEY || '').length);
console.log('VAPID_EMAIL:', process.env.VAPID_EMAIL);
