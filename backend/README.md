# Natural Language Compiler — Backend

FastAPI backend for a Natural-Language-to-C compiler. It converts numbered natural-language instructions into C source code using a locally hosted Qwen3-4B model served through `llama.cpp`. It also supports compiling and running generated C programs through a WebSocket endpoint, streaming program output, handling interactive input, and reporting compilation or execution errors.

The backend does not download or start the model server. The `llama.cpp` server must be started separately.

## Setup

**The easy way:** from the repository root run `npm run dev`. It sets up Python, installs the packages and starts the backend and the frontend together. See the [root README](../README.md). The steps below are for running the backend on its own.

### 1. Install gcc

The backend compiles generated C with gcc. It runs on Linux, macOS and Windows.

- **Linux / macOS:** install gcc with your package manager, such as `sudo apt install gcc` on Ubuntu.
- **Windows:** install [MSYS2](https://www.msys2.org/), then in the "MSYS2 UCRT64" window run `pacman -S mingw-w64-ucrt-x86_64-gcc`. The backend finds gcc in `C:\msys64` by itself. For another location, add its `bin` folder to `PATH` or set `NLC_GCC` to the full path of `gcc.exe`.

If gcc is missing, Compile & Run says how to install it.

### 2. Install dependencies

Python 3.11 or newer is required. From the repository root:

```bash
python -m pip install -r requirements.txt      # Windows: py -m pip install -r requirements.txt
```

### 3. Configure (optional)

Nothing needs configuring: every setting has a default. To change one, copy `backend/.env.example` to `backend/.env` and edit it. See [Configuration](#configuration).

### 4. Start the model server

`npm run dev` does this for you when llama.cpp is installed. To run it by hand, install [llama.cpp](https://github.com/ggml-org/llama.cpp) (on Windows: `winget install llama.cpp`), then run:

```bash
llama-server -hf Qwen/Qwen3-4B-GGUF:Q4_K_M --port 8080 -c 8192 -np 1 --jinja
```

The first run downloads the Qwen3-4B model (about 2.5 GB). `-c 8192` leaves room for the roughly 2,000-token prompt, `-np 1` gives that whole context to one request (newer builds otherwise split it, which cuts answers off), and `--jinja` lets the backend turn off Qwen3's slow "thinking" mode. The backend talks to `http://127.0.0.1:8080/v1/chat/completions`.

### 5. Start the backend

From the repository root, run:

```bash
python backend/main.py      # Windows: py backend\main.py
```

The API listens on `127.0.0.1:8000`. If you change `SERVER_PORT`, also set `VITE_API_BASE_URL` and `VITE_WS_BASE_URL` in `frontend/.env`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `SERVER_PORT` | No | Port used by the FastAPI server. Defaults to `8000`. |
| `LLAMA_PORT` | No | Port used by the local `llama.cpp` server. Defaults to `8080`. |
| `COMPILE_ROUTE` | No | HTTP path for code generation. Defaults to `/compile`; the frontend expects this path. |
| `WS_RUN_ROUTE` | No | WebSocket path for compiling and running C. Defaults to `/ws/run`; the frontend expects this path. |
| `NLC_GCC` | No | Full path to gcc, such as `C:/msys64/ucrt64/bin/gcc.exe`. Defaults to `gcc` on `PATH`, then the usual MSYS2/MinGW folders on Windows. |
| `NLC_EXEC_MODE` | No | `pty` (default on Linux and macOS) or `pipe` (always used on Windows). Set `pipe` on Linux to test the Windows execution path. |

The variables are loaded from `backend/.env` (optional; see `backend/.env.example`) or the process environment.

The model name, temperature (`0.1`), and request prompt are configured in `main.py`.

## API

### 1. Generate C source

**Endpoint:** `POST {COMPILE_ROUTE}`

The endpoint accepts a JSON array of numbered natural-language instructions. The backend sorts the instructions by their `line` values, combines them, prepends the contents of `prefix.txt`, and sends the resulting prompt to the local model server.

Example request:

```json
[
  {
    "line": 1,
    "text": "Read 2 numbers as input"
  },
  {
    "line": 2,
    "text": "Add them"
  },
  {
    "line": 3,
    "text": "Display the answer"
  }
]
```

Example response:

```json
{
  "code": "#include <stdio.h>\n..."
}
```

The `code` field contains the model's answer after light clean-up: any Qwen3 "thinking" text (`<think>…</think>`) and markdown code fences (```` ```c ````) are removed, because neither should reach gcc. A refusal is reduced to its `ERROR: CODE | reason` line (the format `prefix.txt` defines), which the frontend shows as an error instead of putting it in the editor.

**Error handling.** Failures return `{"error": "<message for the user>"}`:

- `422`: the request body is not a JSON array of `{line, text}`.
- `503`: llama-server is not running ("The AI model is not running. Start llama-server on port 8080…").
- `502`: llama-server answered with an error, e.g. while the model is still loading.

The backend waits as long as generation takes; the browser gives up after 5 minutes.

### Health check

**Endpoint:** `GET /health` → `{"backend": "ok", "model": "ok" | "down", "gcc": "<path>"}`

The frontend calls this every few seconds to set the status chip in the header.

### 2. Compile and run C programs

**Endpoint:** `WS /ws/run`

The WebSocket endpoint, implemented in `backend/compiler.py`, compiles C source using GCC and runs the resulting program. It streams compilation status, program output, errors, and process termination information to the client.

#### Client-to-server messages

| Message | Purpose |
| --- | --- |
| `start` | Submit C source for compilation and execution. |
| `stdin` | Send input to the running program. |
| `stop` | Stop the running process. |

Example messages:

```json
{"type": "start", "source": "#include <stdio.h>\nint main(void) { printf(\"Hello\\n\"); return 0; }"}
```

```json
{"type": "stdin", "data": "10 20\n"}
```

```json
{"type": "stop"}
```

#### Server-to-client messages

| Message type | Purpose |
| --- | --- |
| `status` | Reports the current state: `compiling` or `running`. |
| `stdout` | Streams standard output from the program. |
| `stderr` | Streams compiler diagnostics or standard error output. |
| `input_required` | Indicates that the process is blocked waiting for standard input. |
| `exit` | Reports the exit code and phase: `compile` or `run`. |
| `error` | Reports an execution-service error. |

Example messages:

```json
{"type": "status", "state": "compiling"}
```

```json
{"type": "status", "state": "running"}
```

```json
{"type": "stdout", "data": "Hello\n"}
```

```json
{"type": "exit", "code": 0, "phase": "run"}
```

#### Interactive input handling

Unflushed prompts, such as:

```c
printf("Enter a number: ");
```

reach the client before the program blocks waiting for input. How this works depends on the platform:

- **Linux and macOS:** programs run on a pseudo-terminal (PTY). On Linux, the backend detects when a process is actually blocked reading standard input using `/proc/<pid>/syscall`, so a busy-running program is not treated as an interactive prompt.
- **Windows:** there are no PTYs, so programs run on pipes. The backend links a small runtime shim into every build that turns off stdout buffering and stops `\n` from being written as `\r\n`. `input_required` is inferred: the program is running, has printed nothing for 0.25 seconds, and is not using CPU. A program that pauses with `Sleep()` without reading input can therefore briefly unlock the input box.

#### Compiler diagnostics

Compiler diagnostics are streamed through `stderr`. The backend strips its temporary source-file path so that errors are displayed using a readable filename, such as:

```text
program.c:4:5: error: ...
```

#### Compilation flags

GCC uses the following flags on Linux and macOS:

```text
-std=c11 -D_GNU_SOURCE -O1 -pipe -Wall -fstack-protector-strong -D_FORTIFY_SOURCE=2
```

On Windows (MinGW-w64):

```text
-std=c11 -D_GNU_SOURCE -O1 -pipe -Wall -static
```

`-D_GNU_SOURCE` keeps C11 but makes common extras such as `M_PI` and `strdup` available; strict `-std=c11` hides them, which breaks programs like "area of a circle". `-static` means the program needs no MinGW DLLs at run time. The hardening flags are omitted on Windows because many MinGW builds need an extra library for them. The executable is linked with `-lm` for mathematical functions. Warnings on a successful build are shown under the heading "gcc warnings (the program still compiled)".

## Execution limits

The execution service applies the following resource limits:

| Limit | Value |
| --- | --- |
| GCC wall-clock time | 20 seconds |
| Program CPU time | 5 seconds (`RLIMIT_CPU`; on Windows, polled CPU time with a Job Object backstop) |
| Program running time | 60 seconds, not counting time spent waiting for the user to type |
| Total time per run | 15 minutes, including input waits |
| Memory | 256 MB (`RLIMIT_AS`; Job Object on Windows) |
| File writes | 8 MB (`RLIMIT_FSIZE`; not limited on Windows) |
| Child processes | 64 per user on Linux; none allowed on Windows (Job Object) |
| Total streamed output | 1 MB; exceeding the limit kills the program |
| Maximum accepted source size | 256 KB |
| Stop escalation | `SIGTERM` to the process group, followed by `SIGKILL` after 2 seconds; immediate termination on Windows |

Each execution uses a private temporary directory and a scrubbed environment. The temporary directory is removed when the WebSocket connection closes.

These limits constrain resource consumption but do not constitute a complete security sandbox.

## Security considerations

**Do not treat the execution service as safe for arbitrary untrusted C code.**

The resource limits and temporary-directory isolation provide defence in depth, but a hostile program may still read world-readable files or establish network connections.

Running untrusted C code safely requires additional OS-level isolation, such as:

- A container with an appropriately restrictive seccomp profile.
- A network namespace that prevents network access.
- An unprivileged user with minimal permissions.

Deploy the execution service behind suitable isolation before allowing untrusted users to submit programs.

Instructions in `prefix.txt` that ask the model to refuse unsafe programs are not a security boundary. Generated code must be treated as untrusted regardless of the prompt.

CORS currently allows requests from any origin. This configuration is intended for local development and should not be exposed to untrusted networks without appropriate access controls.

## Repository structure

| Path | Purpose |
| --- | --- |
| `backend/main.py` | FastAPI application, HTTP request handling, and local model-server client. |
| `backend/compiler.py` | GCC compilation, process execution, resource limits, and WebSocket streaming. |
| `backend/prefix.txt` | Prompt instructions prepended to each generation request. |
| `backend/.env.example` | Optional settings; copy to `backend/.env` (not committed) to change them. |
| `requirements.txt` | Python dependencies installed by pip (Python 3.11+). |
| `scripts/dev.mjs` | The `npm run dev` launcher: sets up Python and starts backend + frontend. |

## Limitations

- Code generation requires a separately running `llama.cpp` server with the configured model available.
- The browser stops waiting for generated code after 5 minutes.
- Generated C is compiled and executed through the WebSocket endpoint, subject to the documented resource limits.
- Windows enforces fewer limits than Linux: there is no file-size limit, and a program runs for a moment before its memory, CPU and child-process limits apply.
- The execution service is not a complete security sandbox. Additional OS-level isolation is required before running untrusted programs.
- The current CORS configuration permits requests from any origin and is intended only for local development.

