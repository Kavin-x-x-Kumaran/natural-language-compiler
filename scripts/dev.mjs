#!/usr/bin/env node
/**
 * One command to run the whole app:   npm run dev
 *
 * First run: creates a Python environment (.venv) and installs the backend's
 * packages, then installs the frontend's packages. Every run: checks for gcc,
 * starts the AI model with the platform's Qwen script, starts the backend and
 * frontend, and opens the browser. Ctrl+C stops everything.
 *
 * Uses only Node's built-in modules, so it works straight after cloning.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
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
const OLLAMA_PORT = Number(backendEnv.OLLAMA_PORT || 11434);
const APP_URL = `http://localhost:${FRONTEND_PORT}`;

// Set LLAMA_MODEL_FILE in backend/.env to use a local .gguf instead of the
// default Hugging Face model.
const LLAMA_HF_MODEL = 'Qwen/Qwen3-4B-GGUF:Q4_K_M';
const LLAMA_MODEL_FILE = process.env.LLAMA_MODEL_FILE || backendEnv.LLAMA_MODEL_FILE || '';
const QWEN_START_SCRIPT = path.join(ROOT, 'scripts', IS_WINDOWS ? 'start-qwen.ps1' : 'start-qwen.sh');
const LLAMA_AUTOSTART = !/^(0|false|no|off)$/i.test(
  process.env.LLAMA_AUTOSTART || backendEnv.LLAMA_AUTOSTART || 'true'
);
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

/** True if gcc works (PATH, NLC_GCC, or the usual Windows folders). */
function findGcc() {
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
    if (result.status === 0) return result.stdout.split(/\r?\n/)[0].trim();
  }
  return null;
}

const MSYS2_BASH = 'C:\\msys64\\usr\\bin\\bash.exe';
const GCC_PACKAGE_COMMAND = 'pacman -Sy --noconfirm mingw-w64-ucrt-x86_64-gcc';

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`    ${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Windows only: install MSYS2 + gcc with winget, after asking. */
async function offerGccInstall() {
  if (!IS_WINDOWS) return false;
  const haveWinget = spawnSync('winget', ['--version'], { windowsHide: true }).status === 0;
  if (!haveWinget && !existsSync(MSYS2_BASH)) return false;
  if (!(await askYesNo('Install gcc now? (MSYS2 + gcc, about 5 minutes, needs internet)'))) return false;
  if (!existsSync(MSYS2_BASH)) {
    step('Installing MSYS2 (winget)');
    run('winget', ['install', '--id', 'MSYS2.MSYS2', '-e', '--accept-package-agreements', '--accept-source-agreements']);
  }
  if (!existsSync(MSYS2_BASH)) return false;
  step('Installing gcc (MSYS2 pacman)');
  run(MSYS2_BASH, ['-lc', GCC_PACKAGE_COMMAND]);
  return true;
}

async function checkGcc() {
  let version = findGcc();
  if (version) {
    ok(`gcc found (${version})`);
    return;
  }
  warn('gcc was not found, so "Compile & Run" will not work until you install it.');
  if (await offerGccInstall()) {
    version = findGcc();
    if (version) {
      ok(`gcc installed (${version})`);
      return;
    }
    warn('gcc is still not found after installing.');
  }
  if (IS_WINDOWS) {
    hint('Install it from PowerShell, then run npm run dev again:');
    hint('  winget install MSYS2.MSYS2');
    hint(`  ${MSYS2_BASH} -lc "${GCC_PACKAGE_COMMAND}"`);
  } else {
    hint('Install it with your package manager, e.g.: sudo apt install gcc');
  }
}

/** Names of the models Ollama has installed, or null if Ollama is not running. */
function ollamaModels() {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve((JSON.parse(body).models || []).map((model) => model.name));
        } catch {
          resolve(null);
        }
      });
    });
    request.setTimeout(3000, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/** Full path of the platform's Qwen startup script, or null if it is missing. */
function findQwenStartScript() {
  if (!existsSync(QWEN_START_SCRIPT)) return null;
  if (IS_WINDOWS) return QWEN_START_SCRIPT;

  const explicitServer = process.env.LLAMA_SERVER || backendEnv.LLAMA_SERVER;
  if (explicitServer) return existsSync(explicitServer) ? QWEN_START_SCRIPT : null;

  const llamaDir = process.env.LLAMA_DIR || backendEnv.LLAMA_DIR || path.join(homedir(), 'llama.cpp');
  const candidates = [
    path.join(llamaDir, 'build', 'bin', 'llama-server'),
    path.join(llamaDir, 'build', 'bin', 'Release', 'llama-server'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)
      .map((folder) => path.join(folder, 'llama-server')),
  ];
  return candidates.some(existsSync) ? QWEN_START_SCRIPT : null;
}

/**
 * Decide where "Run" gets its AI model from. Returns the llama-server path
 * when it should be started by this script, else null.
 */
async function checkModel() {
  if (await isUp(`http://127.0.0.1:${LLAMA_PORT}/health`, 3000)) {
    ok(`AI model server (llama-server) is already running on port ${LLAMA_PORT}`);
    return null;
  }
  if (!(await portIsFree(LLAMA_PORT))) {
    ok(`Something is already using port ${LLAMA_PORT}; assuming it is llama-server still loading`);
    return null;
  }
  const qwenStartScript = LLAMA_AUTOSTART ? findQwenStartScript() : null;
  if (qwenStartScript) {
    ok(IS_WINDOWS
      ? `Qwen startup script found; it will run in a new PowerShell window (${qwenStartScript})`
      : `Qwen startup script found; it will run after chmod +x (${qwenStartScript})`);
    return qwenStartScript;
  }
  const models = await ollamaModels();
  const qwen = (models || []).filter((name) => name.toLowerCase().startsWith('qwen'));
  if (qwen.length) {
    ok(`AI model: Ollama is running (Qwen models: ${qwen.join(', ')})`);
    return null;
  }
  if (models && models.length) {
    warn(`Ollama is running but has no Qwen model (it has: ${models.join(', ')}).`);
    hint('This app only uses Qwen. Install llama.cpp (winget install llama.cpp), or run:');
    hint('  ollama pull qwen3:4b');
    return null;
  }
  warn(`Qwen startup script was not found at ${QWEN_START_SCRIPT}, so "Run" (English ${SYMBOLS.arrow} C) will not work yet.`);
  hint(`Make sure ${QWEN_START_SCRIPT} exists, then run npm run dev again.`);
  hint('Compile & Run works without it.');
  return null;
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
let modelWindowPid = null;

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (IS_WINDOWS && modelWindowPid !== null) {
    spawnSync('taskkill', ['/pid', String(modelWindowPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    modelWindowPid = null;
  }
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

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Start the model using the platform's Qwen script. */
function startQwenModel(startScript) {
  let ended = false;

  if (IS_WINDOWS) {
    step(`Opening a PowerShell window to run ${startScript}`);
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$window = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit -ExecutionPolicy Bypass -File "${startScript}"' -PassThru; $window.Id`,
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    const pidText = result.stdout ? result.stdout.trim() : '';
    const pid = Number(pidText);
    if (result.error || result.status !== 0 || !Number.isInteger(pid) || pid <= 0) {
      ended = true;
      const details = result.error
        ? result.error.message
        : (result.stderr && result.stderr.trim()) || `PowerShell exited with code ${result.status} without returning a process ID`;
      warn(`Could not open the Qwen PowerShell window: ${details}`);
      return;
    }
    modelWindowPid = pid;
    ok(`Qwen PowerShell window started (PID ${pid})`);
  } else {
    step(`Making ${startScript} executable`);
    const chmod = spawnSync('chmod', ['+x', startScript], { encoding: 'utf8' });
    if (chmod.error || chmod.status !== 0) {
      ended = true;
      const details = chmod.error
        ? chmod.error.message
        : (chmod.stderr && chmod.stderr.trim()) || `chmod exited with code ${chmod.status}`;
      warn(`Could not make the Qwen startup script executable: ${details}`);
      return;
    }
    ok('Qwen startup script is executable');
    step(`Starting the AI model with ${startScript}`);
    const child = spawn(startScript, [], {
      cwd: ROOT,
      env: {
        ...process.env,
        LLAMA_DIR: process.env.LLAMA_DIR || backendEnv.LLAMA_DIR || '',
        LLAMA_HF_MODEL,
        LLAMA_MODEL_FILE,
        LLAMA_PORT: String(LLAMA_PORT),
        LLAMA_SERVER: process.env.LLAMA_SERVER || backendEnv.LLAMA_SERVER || '',
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    children.push(child);

    const report = (why) => {
      if (ended || stopping) return;
      ended = true;
      warn(`The Qwen startup script ${why}; "Run" will not work. Check its output above. Compile & Run still works.`);
    };
    child.on('error', (error) => report(`could not start (${error.message})`));
    child.on('exit', (code) => report(`stopped (exit code ${code})`));
  }

  // Tell the user when the model is ready, and that it is still working.
  (async () => {
    const started = Date.now();
    let lastNote = started;
    let readyReported = false;
    while (!ended && !stopping) {
      if (IS_WINDOWS && modelWindowPid !== null && !isProcessRunning(modelWindowPid)) {
        ended = true;
        if (!stopping) warn('The Qwen PowerShell window exited; "Run" may not work.');
        return;
      }
      if (!readyReported && await isUp(`http://127.0.0.1:${LLAMA_PORT}/health`, 3000)) {
        if (!stopping) {
          console.log(`\n  ${green(SYMBOLS.ok)} ${bold('The AI model is ready.')} Press "Run" in the browser.\n`);
        }
        readyReported = true;
      }
      if (!readyReported && Date.now() - lastNote >= 60000) {
        lastNote = Date.now();
        const minutes = Math.round((lastNote - started) / 60000);
        hint(IS_WINDOWS
          ? `... the AI model is still loading (${minutes} min so far; see the PowerShell window)`
          : `... the AI model is still loading (${minutes} min so far; the first start downloads 2.5 GB)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  })();
}

/** POST JSON with node:http; resolves to { status, body } or { error }. */
function postJson(url, data, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const request = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(text) });
          } catch {
            resolve({ status: response.statusCode, body: {} });
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timed out')));
    request.on('error', (error) => resolve({ error: error.message }));
    request.end(body);
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
    });
    request.setTimeout(5000, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/**
 * Once the AI model is up, generate the adder example once through the
 * backend: proves "Run" works end to end, and warms the model up so the
 * first real Run is faster.
 */
async function testModel() {
  if (process.env.NLC_SKIP_MODEL_TEST) return;
  const deadline = Date.now() + 30 * 60 * 1000;
  let health;
  for (;;) {
    if (stopping || Date.now() > deadline) return;
    health = await getJson(`http://127.0.0.1:${BACKEND_PORT}/health`);
    if (health && health.model === 'ok') break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const server = health.model_server || 'unknown';
  hint(`Testing the AI model (${server}) with the "adder" example (this also warms it up)...`);
  if (!/qwen/i.test(server)) {
    warn(`This does not look like a Qwen model (${server}). The app is built for Qwen3 4B; other models may refuse ordinary programs.`);
  }
  const started = Date.now();
  const result = await postJson(
    `http://127.0.0.1:${BACKEND_PORT}/compile`,
    [
      { line: 1, text: 'Read 2 numbers as input' },
      { line: 2, text: 'Add them' },
      { line: 3, text: 'Display the answer' },
    ],
    10 * 60 * 1000
  );
  if (stopping) return;
  const seconds = Math.round((Date.now() - started) / 1000);
  const code = result.body && typeof result.body.code === 'string' ? result.body.code : '';
  if (result.status === 200 && code.includes('main') && !code.startsWith('ERROR:')) {
    console.log(`\n  ${green(SYMBOLS.ok)} ${bold('AI model test passed')} (${server}): it wrote C code for the adder example in ${seconds}s.\n`);
    return;
  }
  const what = result.error
    ? `could not reach the backend (${result.error})`
    : code.startsWith('ERROR:')
      ? `the model refused the adder example: ${code.trim()}`
      : (result.body && result.body.error) || `unexpected answer (HTTP ${result.status})`;
  console.log(`\n  ${yellow('!')} AI model test failed (${server}): ${what}`);
  hint('"Run" may not work properly. Check the Qwen startup output above, and confirm the model is Qwen3 4B.\n');
}

async function main() {
  console.log(bold(`\nNatural Language ${SYMBOLS.arrow} C compiler`));

  step('Checking your setup');
  checkNode();
  setupPython();
  setupFrontend();
  await checkGcc();
  const qwenStartScript = await checkModel();
  await checkPorts();

  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  if (qwenStartScript) startQwenModel(qwenStartScript);

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
    testModel();
  }
}

main().catch((error) => {
  console.error(error);
  stopAll(1);
});