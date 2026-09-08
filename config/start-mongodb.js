const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MONGODB_BIN_DIR =
  'C:\\Users\\DVolodin\\Downloads\\mongodb-windows-x86_64-8.3.8\\mongodb-win32-x86_64-windows-8.3.8\\bin';
const MONGOD_PATH = path.join(MONGODB_BIN_DIR, 'mongod.exe');
const DB_PATH = path.join(__dirname, '..', 'data', 'db');
const PORT = 27017;

if (!fs.existsSync(MONGOD_PATH)) {
  console.error(`mongod.exe not found at ${MONGOD_PATH}`);
  process.exit(1);
}

fs.mkdirSync(DB_PATH, { recursive: true });

const mongod = spawn(MONGOD_PATH, ['--dbpath', DB_PATH, '--port', String(PORT)], {
  stdio: 'inherit',
});

mongod.on('exit', (code) => process.exit(code ?? 0));
