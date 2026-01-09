const { spawn } = require('child_process');
const fs = require('fs');

const log = fs.createWriteStream('server_run.log');

const child = spawn('npx', ['ts-node', 'src/index.ts'], {
    env: process.env,
    shell: true
});

child.stdout.on('data', (data) => {
    log.write(`STDOUT: ${data}`);
});

child.stderr.on('data', (data) => {
    log.write(`STDERR: ${data}`);
});

child.on('close', (code) => {
    log.write(`Process exited with code ${code}`);
});

setTimeout(() => {
    console.log('Server run check completed. View server_run.log');
    process.exit(0);
}, 10000);
