const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CODEAPI_DIR = path.join(__dirname, '..', 'codeapi_server');
const VENV_PYTHON =
  process.platform === 'win32'
    ? path.join(CODEAPI_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(CODEAPI_DIR, '.venv', 'bin', 'python');

if (!fs.existsSync(VENV_PYTHON)) {
  console.error(
    `Python venv not found at ${VENV_PYTHON}. Create it with: cd codeapi_server && python3 -m venv .venv && ` +
      `${process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'} -m pip install -r requirements.txt`,
  );
  process.exit(1);
}

const codeapi = spawn(VENV_PYTHON, ['app.py'], { cwd: CODEAPI_DIR, stdio: 'inherit' });
codeapi.on('exit', (code) => process.exit(code ?? 0));
