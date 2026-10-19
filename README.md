# Natural Language → C Compiler

Type the steps of a program in plain English, one per line:

```text
Read 2 numbers as input
Add them
Display the answer
```

Press **Run** and a local AI model (Qwen3-4B, running on your own computer with
llama.cpp) writes the C program. Press **Compile & Run** and it is compiled
with gcc and run, with an interactive terminal for its input and output.

![The app: English steps on the left, generated C below, program output on the right](docs/screenshot.png)

## 1. Install these once

| what | why | how (Windows) |
| --- | --- | --- |
| **Node.js** 18 or newer | runs the app | [nodejs.org](https://nodejs.org) → the LTS installer |
| **Python** 3.11 or newer | runs the backend | [python.org/downloads](https://www.python.org/downloads/). In the installer, tick **"Add python.exe to PATH"** |
| **gcc** | compiles the C code | Install [MSYS2](https://www.msys2.org/), open the **"MSYS2 UCRT64"** window and run `pacman -S mingw-w64-ucrt-x86_64-gcc` |
| **llama.cpp** | runs the AI model | In a terminal: `winget install llama.cpp` |

On Linux or macOS, install the same four with your package manager
(e.g. `sudo apt install nodejs npm python3 python3-venv gcc`, plus llama.cpp).

After installing, **close and reopen VS Code** so it sees the new programs.

## 2. Run it

1. In VS Code: **File → Open Folder…** and choose this project folder.
2. **Terminal → New Terminal**, and start the AI model:

   ```bash
   llama-server -hf Qwen/Qwen3-4B-GGUF:Q4_K_M --port 8080 -c 8192 --jinja
   ```

   The first time, this downloads the model (about 2.5 GB). Leave this
   terminal open.
3. Open a **second** terminal (the **+** button in the terminal panel) and run:

   ```bash
   npm run dev
   ```

   The first run sets everything up (a few minutes). Your browser then opens
   **http://localhost:5173**.

To stop the app, press **Ctrl+C** in that terminal.

## 3. Use it

1. Write steps in **Natural language** (or use the two example tabs).
2. Press **Run**. The C code appears under **Generated C source**.
3. Press **Compile & Run**. Output appears on the right. When the program asks
   for input, type it in the box at the bottom of the Output panel and press
   **Enter**.

The chip in the top-right corner shows what is working:

| chip | meaning |
| --- | --- |
| **Ready** (green) | everything is running |
| **AI model not running** (amber) | Compile & Run works, but **Run** needs llama-server (step 2.2) |
| **Backend not running** (red) | start the app with `npm run dev` |

## Troubleshooting

| you see | do this |
| --- | --- |
| `npm.ps1 cannot be loaded … running scripts is disabled` | Open a new terminal: this project sets VS Code to use Command Prompt, which avoids it. Or run once in PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `Python 3.11 or newer was not found` | Install Python (step 1), tick "Add python.exe to PATH", then reopen VS Code |
| `gcc (the C compiler) was not found` | Install gcc with MSYS2 (step 1), then restart `npm run dev` |
| `The AI model is not running` | Start llama-server (step 2.2) and press **Run** again |
| `The AI model is still loading` | Wait a few seconds after starting llama-server, then press **Run** again |
| `Port 8000 is already in use` | The app is already running in another terminal; use that one or stop it with Ctrl+C |
| `llama-server` is not recognized | Reopen VS Code after `winget install`, or download a Windows build from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) |
| **Run** is slow | Normal on a laptop CPU: generation can take 30–60 seconds |

## What is in this repository

| path | contents |
| --- | --- |
| `frontend/` | React + Vite web UI. See [`frontend/README.md`](frontend/README.md) |
| `backend/` | FastAPI service: talks to the model and compiles/runs C with gcc. See [`backend/README.md`](backend/README.md) |
| `scripts/dev.mjs` | what `npm run dev` runs: sets up Python, starts backend + frontend |
| `requirements.txt` | the backend's Python packages |

**Safety note:** the app compiles and runs the generated C on your computer,
with time, memory and output limits, but these limits are not a sandbox. Run
it on your own machine, not as a public service. See
[`backend/README.md`](backend/README.md#security-considerations).
