#!/usr/bin/env node
/**
 * One command to run the whole app:   npm run dev
 *
 * First run: creates a Python environment (.venv) and installs the backend's
 * packages, then installs the frontend's packages. Every run: checks for gcc
 * and the AI model, starts the backend and the frontend, and opens the
 * browser. Ctrl+C stops everything.
 *
 * Uses only Node's built-in modules, so it works straight after cloning.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');
const BACKEND_MAIN = path.join(ROOT, 'backend', 'main.py');
const REQUIREMENTS = path.join(ROOT, 'requirements.txt');
const VENV = path.join(ROOT, '.venv');
const IS_WINDOWS = process.platform === 'win32';
const VENV_PYTHON = IS_WINDOWS
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');
const VITE = path.join(FRONTEND, 'node_modules', 'vite', 'bin', 'vite.js');

const backendEnv = readEnvFile(path.join(ROOT, 'backend', '.env'));
const BACKEND_PORT = Number(backendEnv.SERVER_PORT || 8000);
const LLAMA_PORT = Number(backendEnv.LLAMA_PORT || 8080);
const FRONTEND_PORT = 5173;
const APP_URL = `http://localhost:${FRONTEND_PORT}`;

// ---------------------------------------------------------------- output

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color('1');
const green = color('32');
const yellow = color('33');
const red = color('31');
const SYMBOLS = IS_WINDOWS
  ? { step: '>', ok: 'OK', fail: 'X', arrow: '->' } // older Windows consoles lack ▶ ✓ ✗ →
  : { step: '▶', ok: '✓', fail: '✗', arrow: '→' };
const step = (text) => console.log(`\n${bold(SYMBOLS.step)} ${text}`);
const ok = (text) => console.log(`  ${green(SYMBOLS.ok)} ${text}`);
const warn = (text) => console.log(`  ${yellow('!')} ${text}`);
const hint = (text) => console.log(`    ${text}`);

function fail(message, ...hints) {
  console.log(`\n  ${red(SYMBOLS.fail)} ${message}`);
  for (const line of hints) hint(line);
  console.log('');
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

function readEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}

/** Run a command to completion, showing its output. Returns true on success. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  return result.status === 0;
}

/** Python version as [major, minor], or null if `command` is not a working Python. */
function pythonVersion(command, args = []) {
  const result = spawnSync(
    command,
    [...args, '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'],
    { encoding: 'utf8', windowsHide: true }
  );
  if (result.status !== 0 || !result.stdout) return null;
  const [major, minor] = result.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) ? [major, minor] : null;
}

const atLeast311 = (v) => v && (v[0] > 3 || (v[0] === 3 && v[1] >= 11));

function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** True if `url` answers with HTTP 2xx. Uses node:http rather than fetch(),
 *  which prints an ExperimentalWarning on Node 18. */
function isUp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    // 3s: on Windows a refused connection takes about 2s to fail.
    if (await isUp(url, 3000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Run npm itself, the same npm that launched this script when possible. */
function npm(args, cwd) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], { cwd });
  }
  // Started as `node scripts/dev.mjs`: npm is npm.cmd on Windows.
  return run(IS_WINDOWS ? 'npm.cmd' : 'npm', args, { cwd, shell: IS_WINDOWS });
}

// ---------------------------------------------------------------- checks

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`Node.js ${process.versions.node} is too old.`, 'Install Node.js 18 or newer (LTS) from https://nodejs.org');
  }
  ok(`Node.js ${process.versions.node}`);
}

function findBasePython() {
  const candidates = IS_WINDOWS
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [command, args] of candidates) {
    const version = pythonVersion(command, args);
    if (atLeast311(version)) return { command, args, version };
  }
  return null;
}

function setupPython() {
  let version = existsSync(VENV_PYTHON) ? pythonVersion(VENV_PYTHON) : null;

  if (!atLeast311(version)) {
    const base = findBasePython();
    if (!base) {
      fail(
        'Python 3.11 or newer was not found.',
        IS_WINDOWS
          ? 'Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".'
          : 'Install it with your package manager, e.g.: sudo apt install python3 python3-venv',
        'Then close and reopen VS Code, and run: npm run dev'
      );
    }
    step(`Creating the Python environment (.venv) with Python ${base.version.join('.')} (first run only)`);
    if (!run(base.command, [...base.args, '-m', 'venv', VENV], { cwd: ROOT })) {
      fail(
        'Could not create the Python environment.',
        IS_WINDOWS ? 'Try reinstalling Python from python.org.' : 'On Ubuntu/Debian: sudo apt install python3-venv'
      );
    }
    version = pythonVersion(VENV_PYTHON);
  }

  const stamp = path.join(VENV, '.nlc-requirements');
  const wanted = fileHash(REQUIREMENTS);
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== wanted) {
    step('Installing the backend\'s Python packages (first run only, takes a minute)');
    const installed = run(
      VENV_PYTHON,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', REQUIREMENTS],
      { cwd: ROOT }
    );
    if (!installed) {
      fail('Installing Python packages failed (see the messages above).', 'Check your internet connection, then run: npm run dev');
    }
    writeFileSync(stamp, wanted);
  }
  ok(`Python ${version.join('.')} environment ready`);
}

function setupFrontend() {
  const lockfile = path.join(FRONTEND, 'package-lock.json');
  const stamp = path.join(FRONTEND, 'node_modules', '.nlc-lock');
  const wanted = existsSync(lockfile) ? fileHash(lockfile) : 'none';
  if (!existsSync(VITE) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== wanted) {
    step('Installing the frontend\'s packages (first run only, takes a minute)');
    if (!npm(['install', '--no-audit', '--no-fund'], FRONTEND) || !existsSync(VITE)) {
      fail('Installing frontend packages failed (see the messages above).', 'Check your internet connection, then run: npm run dev');
    }
    writeFileSync(stamp, wanted);
  }
  ok('Frontend packages ready');
}

function checkGcc() {
  const explicit = process.env.NLC_GCC || backendEnv.NLC_GCC;
  const guesses = IS_WINDOWS
    ? [
        'C:\\msys64\\ucrt64\\bin\\gcc.exe',
        'C:\\msys64\\mingw64\\bin\\gcc.exe',
        'C:\\mingw64\\bin\\gcc.exe',
        'C:\\MinGW\\bin\\gcc.exe',
      ]
    : [];
  const candidates = [explicit, 'gcc', ...guesses.filter((g) => existsSync(g))].filter(Boolean);
  for (const gcc of candidates) {
    const result = spawnSync(gcc, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      ok(`gcc found (${result.stdout.split(/\r?\n/)[0].trim()})`);
      return;
    }
  }
  warn('gcc was not found, so "Compile & Run" will not work until you install it.');
  if (IS_WINDOWS) {
    hint('Install MSYS2 from https://www.msys2.org/ then, in the "MSYS2 UCRT64" window, run:');
    hint('  pacman -S mingw-w64-ucrt-x86_64-gcc');
  } else {
    hint('Install it with your package manager, e.g.: sudo apt install gcc');
  }
}

async function checkModel() {
  if (await isUp(`http://127.0.0.1:${LLAMA_PORT}/health`)) {
    ok(`AI model server (llama-server) is running on port ${LLAMA_PORT}`);
    return;
  }
  warn(`The AI model server (llama-server) is not running on port ${LLAMA_PORT}.`);
  hint(`The app will open, but "Run" (English ${SYMBOLS.arrow} C) needs it. In a second terminal, run:`);
  hint(`  llama-server -hf Qwen/Qwen3-4B-GGUF:Q4_K_M --port ${LLAMA_PORT} -c 8192 --jinja`);
  hint('See the README for how to install llama.cpp.');
}

async function checkPorts() {
  for (const [port, what] of [[BACKEND_PORT, 'backend'], [FRONTEND_PORT, 'frontend']]) {
    if (!(await portIsFree(port))) {
      fail(
        `Port ${port} (${what}) is already in use.`,
        'The app may already be running in another terminal. Close it (Ctrl+C) and try again.'
      );
    }
  }
}

// ---------------------------------------------------------------- run

const children = [];
let stopping = false;

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (IS_WINDOWS) {
      // Ends the whole tree (e.g. a program still running under the backend).
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(exitCode), 300);
}

function start(name, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  children.push(child);
  child.on('error', (error) => {
    console.log(`\n  ${red(SYMBOLS.fail)} Could not start the ${name}: ${error.message}`);
    stopAll(1);
  });
  child.on('exit', (code) => {
    if (stopping) return;
    console.log(`\n  ${red(SYMBOLS.fail)} The ${name} stopped (exit code ${code}). Stopping the app.`);
    stopAll(code || 1);
  });
  return child;
}

async function main() {
  console.log(bold(`\nNatural Language ${SYMBOLS.arrow} C compiler`));

  step('Checking your setup');
  checkNode();
  setupPython();
  setupFrontend();
  checkGcc();
  await checkModel();
  await checkPorts();

  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  step(`Starting the backend on port ${BACKEND_PORT}`);
  start('backend', VENV_PYTHON, [BACKEND_MAIN], {
    cwd: ROOT,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
  });
  // "/" answers at once; "/health" also checks the AI model, which can be slow.
  if (!(await waitFor(`http://127.0.0.1:${BACKEND_PORT}/`, 60))) {
    if (!stopping) {
      console.log(`\n  ${red(SYMBOLS.fail)} The backend did not start (see the messages above).`);
      stopAll(1);
    }
    return;
  }

  step('Starting the frontend');
  const viteArgs = [VITE, '--port', String(FRONTEND_PORT), '--strictPort'];
  if (!process.env.NLC_NO_BROWSER) viteArgs.push('--open');
  start('frontend', process.execPath, viteArgs, { cwd: FRONTEND });
  if (await waitFor(APP_URL, 60)) {
    console.log(`\n  ${green(SYMBOLS.ok)} ${bold('The app is running:')} ${bold(APP_URL)}`);
    console.log('    Press Ctrl+C here to stop it.\n');
  }
}

main().catch((error) => {
  console.error(error);
  stopAll(1);
});
