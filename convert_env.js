
const fs = require('fs');
const content = fs.readFileSync('.env', 'utf16le');
fs.writeFileSync('.env', content, 'utf8');
console.log('Converted .env to UTF-8');
