const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Lives outside this repo (a sibling of the LibreChat checkout, not the
// worktree it may be running from) - a relative path off __dirname breaks
// under git worktrees, so the default is absolute.
const LLM_SERVER_DIR = process.env.LLM_SERVER_DIR || '/home/daniel/local-llm-server';
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

const llmServer = spawn(VENV_PYTHON, ['main.py'], { cwd: LLM_SERVER_DIR, stdio: 'inherit' });
llmServer.on('exit', (code) => process.exit(code ?? 0));
