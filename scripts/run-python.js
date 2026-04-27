#!/usr/bin/env node
/**
 * Cross-platform launcher for the Python OCR sidecar.
 * Usage:
 *   node scripts/run-python.js           - starts the OCR server
 *   node scripts/run-python.js setup     - creates venv and installs deps
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PY_DIR = path.join(PROJECT_ROOT, 'python-ocr');
const IS_WINDOWS = process.platform === 'win32';

const VENV_PYTHON = IS_WINDOWS
  ? path.join(PY_DIR, 'venv', 'Scripts', 'python.exe')
  : path.join(PY_DIR, 'venv', 'bin', 'python');

const VENV_PIP = IS_WINDOWS
  ? path.join(PY_DIR, 'venv', 'Scripts', 'pip.exe')
  : path.join(PY_DIR, 'venv', 'bin', 'pip');

function which(cmd) {
  // Find a working python binary on PATH
  const candidates = IS_WINDOWS ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const { execSync } = require('child_process');
      execSync(`${c} --version`, { stdio: 'ignore' });
      return c;
    } catch { /* try next */ }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });
}

async function setup() {
  const py = which();
  if (!py) {
    console.error('[setup] No Python found on PATH. Install Python 3.9+ and try again.');
    process.exit(1);
  }
  console.log(`[setup] Creating venv with ${py}...`);
  await run(py, ['-m', 'venv', 'venv'], { cwd: PY_DIR });
  console.log('[setup] Installing requirements (this takes 5-10 minutes)...');
  await run(VENV_PIP, ['install', '-r', 'requirements.txt'], { cwd: PY_DIR });
  console.log('[setup] Done. Run "npm start" next.');
}

async function start() {
  if (!fs.existsSync(VENV_PYTHON)) {
    console.error('[OCR] venv not found. Run "npm run setup:python" first.');
    process.exit(1);
  }
  await run(VENV_PYTHON, ['app.py'], { cwd: PY_DIR });
}

const cmd = process.argv[2];
(cmd === 'setup' ? setup() : start()).catch((err) => {
  console.error('[run-python]', err.message);
  process.exit(1);
});
