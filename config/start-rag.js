const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RAG_DIR = path.join(__dirname, '..', 'rag_server');
const VENV_PYTHON =
  process.platform === 'win32'
    ? path.join(RAG_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(RAG_DIR, '.venv', 'bin', 'python');

if (!fs.existsSync(VENV_PYTHON)) {
  console.error(
    `Python venv not found at ${VENV_PYTHON}. Create it with: cd rag_server && python -m venv .venv && ` +
      `${process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'} -m pip install -r requirements.txt`,
  );
  process.exit(1);
}

const rag = spawn(VENV_PYTHON, ['app.py'], { cwd: RAG_DIR, stdio: 'inherit' });
rag.on('exit', (code) => process.exit(code ?? 0));
