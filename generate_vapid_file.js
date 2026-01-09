
const webpush = require('web-push');
const fs = require('fs');
const vapidKeys = webpush.generateVAPIDKeys();
const output = `Public Key: ${vapidKeys.publicKey}\nPrivate Key: ${vapidKeys.privateKey}`;
fs.writeFileSync('vapid_keys.txt', output);
console.log('Keys generated in vapid_keys.txt');
