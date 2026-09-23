const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killTreeOnExit } = require('./killProcessTree');

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

// `detached: true` makes `app.py` the leader of its own new process group
// (POSIX) rather than sharing this wrapper's - its own sandboxed-execution
// subprocesses (see app.py's own comment on why `reload=False`) inherit
// that group too, so `killTreeOnExit` below reaches them even if this
// wrapper (or the terminal running `npm run dev`) goes away without a clean
// shutdown - same fix, same rationale, as start-llm-server.js.
const codeapi = spawn(VENV_PYTHON, ['app.py'], {
  cwd: CODEAPI_DIR,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

killTreeOnExit(codeapi, '[codeapi]');
codeapi.on('exit', (code) => process.exit(code ?? 0));
