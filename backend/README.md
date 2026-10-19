# Natural Language Compiler — Backend

FastAPI backend for a Natural-Language-to-C compiler. It converts numbered natural-language instructions into C source code using a locally hosted Qwen3-4B model served through `llama.cpp`. It also supports compiling and running generated C programs through a WebSocket endpoint, streaming program output, handling interactive input, and reporting compilation or execution errors.

The backend does not download or start the model server. The `llama.cpp` server must be started separately.

## Setup

### 1. Install gcc

The backend compiles generated C with gcc. It runs on Linux, macOS and Windows.

- **Linux / macOS:** install gcc with your package manager, such as `sudo apt install gcc` on Ubuntu.
- **Windows:** install MinGW-w64, for example through [MSYS2](https://www.msys2.org/) with `pacman -S mingw-w64-ucrt-x86_64-gcc`. Add its `bin` folder (such as `C:\msys64\ucrt64\bin`) to `PATH`, or set `NLC_GCC` to the full path of `gcc.exe`.

Check the installation with `gcc --version` in a new terminal. If gcc is missing, Compile & Run reports how to install it.

### 2. Install dependencies

From the repository root, install the Python dependencies:

```bash
pip install -r requirements.txt
```

### 3. Configure environment variables

Create `backend/.env` with the following configuration:

```dotenv
COMPILE_ROUTE=/compile
SERVER_PORT=8000
LLAMA_PORT=8080
```

These values configure the HTTP generation endpoint, the FastAPI server port, and the local `llama.cpp` server port, respectively.

### 4. Start the model server

Start a `llama.cpp` server separately, exposing its OpenAI-compatible chat completions endpoint at:

```text
http://127.0.0.1:8080/v1/chat/completions
```

The server should serve the model `Qwen3-4B-Q4_K_M.gguf`.

### 5. Start the backend

From the repository root, run:

```bash
python backend/main.py
```

The API listens on `127.0.0.1:8000` by default, according to the example configuration.

If you change `SERVER_PORT` or `LLAMA_PORT`, ensure that the frontend's API base URL and the backend's connection to `llama.cpp` use the corresponding ports.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `COMPILE_ROUTE` | Yes | HTTP path for the code-generation endpoint, such as `/compile`. |
| `SERVER_PORT` | Yes | Port used by the FastAPI server. |
| `LLAMA_PORT` | Yes | Port used by the local `llama.cpp` server. |
| `WS_RUN_ROUTE` | No | WebSocket path for compiling and running C. Defaults to `/ws/run`. |
| `NLC_GCC` | No | Full path to gcc, such as `C:\msys64\ucrt64\bin\gcc.exe`. Defaults to `gcc` on `PATH`. |
| `NLC_EXEC_MODE` | No | `pty` (default on Linux and macOS) or `pipe` (always used on Windows). Set `pipe` on Linux to test the Windows execution path. |

The variables are loaded from `backend/.env` or the process environment. The first three must be configured; the application does not provide code-level defaults for them.

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

The `code` field contains the model output verbatim.

**Error handling:**

- `422 Unprocessable Entity`: FastAPI rejects invalid request data.
- `500 Internal Server Error`: The `llama.cpp` request fails. The response detail is `llama.cpp server is down`.

Generation has no request timeout because the duration depends on model loading and output length.

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
-std=c11 -O1 -Wall -Wextra -fstack-protector-strong -D_FORTIFY_SOURCE=2
```

On Windows (MinGW-w64):

```text
-std=c11 -O1 -Wall -Wextra -static
```

`-static` means the program needs no MinGW DLLs at run time. The hardening flags are omitted on Windows because many MinGW builds need an extra library for them. The executable is linked with `-lm` for mathematical functions.

## Execution limits

The execution service applies the following resource limits:

| Limit | Value |
| --- | --- |
| GCC wall-clock time | 20 seconds |
| Program CPU time | 5 seconds (`RLIMIT_CPU`; on Windows, polled CPU time with a Job Object backstop) |
| Program wall-clock time | 60 seconds |
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
| `backend/.env` | Local service ports and HTTP route configuration; not committed to version control. |
| `requirements.txt` | Python dependencies installed by pip. |

## Limitations

- Code generation requires a separately running `llama.cpp` server with the configured model available.
- Generation has no request timeout.
- Generated C is compiled and executed through the WebSocket endpoint, subject to the documented resource limits.
- Windows enforces fewer limits than Linux: there is no file-size limit, and a program runs for a moment before its memory, CPU and child-process limits apply.
- The execution service is not a complete security sandbox. Additional OS-level isolation is required before running untrusted programs.
- The current CORS configuration permits requests from any origin and is intended only for local development.

