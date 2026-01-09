
const fs = require('fs');
const content = `VAPID_PUBLIC_KEY=BFMAqh477apr57eNrMZ1wj3T5r04s1y0OBAPr_sorJITpj4zv78CFpOAY5cmkqKig8fDjaQWo3wUNdmPYMtXbwM
VAPID_PRIVATE_KEY=-H4d_sxPSreK0XCgiB_V3e6wqVBVBxamIC6ME-5HSlI
VAPID_EMAIL=admin@sale-pilot.com
`;

// Also add back other likely variables if I knew them, but I don't.
// Actually, I should try to preserve existing ones if they are not corrupted.

let existing = '';
try {
    // Try to read as UTF-8 first
    existing = fs.readFileSync('.env', 'utf8');
    if (existing.includes('\0')) {
        existing = fs.readFileSync('.env', 'utf16le');
    }
} catch (e) { }

const newLines = content.split('\n');
let lines = existing.split('\n');

newLines.forEach(newLine => {
    if (!newLine.trim()) return;
    const [key] = newLine.split('=');
    const index = lines.findIndex(l => l.startsWith(key + '='));
    if (index > -1) {
        lines[index] = newLine;
    } else {
        lines.push(newLine);
    }
});

fs.writeFileSync('.env', lines.join('\n'), 'utf8');
console.log('Final .env update done');
