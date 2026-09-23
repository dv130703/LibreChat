const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killTreeOnExit } = require('./killProcessTree');

// Lives outside this repo (a sibling of the LibreChat checkout, not the
// worktree it may be running from) - a relative path off __dirname breaks
// under git worktrees, so the default is absolute.
const LLM_SERVER_DIR = process.env.LLM_SERVER_DIR || '/home/daniel/Local LLM Server';
const VENV_PYTHON =
  process.platform === 'win32'
    ? path.join(LLM_SERVER_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(LLM_SERVER_DIR, '.venv', 'bin', 'python');

if (!fs.existsSync(VENV_PYTHON)) {
  console.warn(
    `[llm-server] Skipping - venv not found at ${VENV_PYTHON}. Set LLM_SERVER_DIR if local-llm-server lives elsewhere.`,
  );
  process.exit(0);
}

// `detached: true` makes `main.py` the leader of its own new process group
// (POSIX) rather than sharing this wrapper's - main.py's own children
// (the 3 uvicorn services) and THEIR children (each request's watchdog
// subprocess, see Transcription Pipeline/api/watchdog.py) inherit that same
// group automatically. That's what makes `killTreeOnExit` below actually
// work: main.py's own SIGTERM/SIGINT handler only ever signals its 3 direct
// children, never a request's own watchdog subprocess two levels further
// down - without a shared group to target directly, a hung GPU job would
// survive this wrapper exiting and keep holding the GPU lock indefinitely.
const llmServer = spawn(VENV_PYTHON, ['main.py'], {
  cwd: LLM_SERVER_DIR,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

killTreeOnExit(llmServer, '[llm-server]');
llmServer.on('exit', (code) => process.exit(code ?? 0));
