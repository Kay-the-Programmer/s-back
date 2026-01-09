
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');

let content = '';
if (fs.existsSync(envPath)) {
    // Try to read existing content safely
    try {
        content = fs.readFileSync(envPath, 'utf8');
        // If it looks like UTF-16 (lots of null bytes or weirdness), try reading as UTF-16
        if (content.includes('\0')) {
            content = fs.readFileSync(envPath, 'utf16le');
        }
    } catch (e) {
        content = '';
    }
}

const keys = [
    'VAPID_PUBLIC_KEY=BFMAqh477apr57eNrMZ1wj3T5r04s1y0OBAPr_sorJITpj4zv78CFpOAY5cmkqKig8fDjaQWo3wUNdmPYMtXbwM',
    'VAPID_PRIVATE_KEY=-H4d_sxPSreK0XCgiB_V3e6wqVBVBxamIC6ME-5HSlI',
    'VAPID_EMAIL=admin@sale-pilot.com'
];

let lines = content.split('\n').filter(line => line.trim() !== '');
keys.forEach(key => {
    const name = key.split('=')[0];
    const index = lines.findIndex(l => l.startsWith(name + '='));
    if (index > -1) {
        lines[index] = key;
    } else {
        lines.push(key);
    }
});

fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
console.log('Updated .env with VAPID keys (UTF-8)');
