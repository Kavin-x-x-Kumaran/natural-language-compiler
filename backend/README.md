# Natural language compiler — backend

FastAPI service that turns numbered natural-language instructions into C
source using a local `llama.cpp` server and the Qwen3-4B model. It implements
the frontend's HTTP generation endpoint; compiling and running generated C
code is not implemented by this backend.

## Setup

From the repository root, install the Python dependencies:

```bash
pip install -r requirements.txt
```

Create `backend/.env` with the service and `llama.cpp` ports:

```dotenv
COMPILE_ROUTE=/compile
SERVER_PORT=8000
LLAMA_PORT=8080
```

Start a `llama.cpp` server separately, exposing its OpenAI-compatible chat
completions endpoint at `http://127.0.0.1:8080/v1/chat/completions` and serving
the model `Qwen3-4B-Q4_K_M.gguf`. The backend does not download or start the
model server.

Run the API from the repository root:

```bash
python backend/main.py
```

The API listens on `127.0.0.1:8000` by default. Change `SERVER_PORT` or
`LLAMA_PORT` in `backend/.env` to use different ports; keep the frontend's API
base URL and the `llama.cpp` server address in sync.

## Configuration

| variable | required | default | description |
| --- | --- | --- | --- |
| `COMPILE_ROUTE` | yes | — | HTTP path for the generation endpoint, such as `/compile` |
| `SERVER_PORT` | yes | — | Port used by the FastAPI server |
| `LLAMA_PORT` | yes | — | Port of the local `llama.cpp` server |

These variables are loaded from `backend/.env` or the process environment.
There are no code defaults; all three must be set. The model name,
temperature (`0.1`), and request prompt are configured in `main.py`.

## API

### Generate C source

`POST /compile` (or the path set by `COMPILE_ROUTE`) accepts a JSON array of
numbered instructions. The backend sorts the lines by their `line` value,
combines them, and sends them with `prefix.txt` to the model.

```json
[
  { "line": 1, "text": "Read 2 numbers as input" },
  { "line": 2, "text": "Add them" },
  { "line": 3, "text": "Display the answer" }
]
```

On success, the response contains the model output verbatim:

```json
{ "code": "#include <stdio.h>\n..." }
```

Invalid request data is rejected by FastAPI with a `422` response. If the
`llama.cpp` request fails, the API returns `500` with the detail
`llama.cpp server is down`. Generation has no request timeout because duration
depends on model loading and output length.

### Running C: `WS /ws/run`

`backend/compiler.py` builds generated C with gcc and runs it, streaming the
session over a WebSocket. Messages:

```
client -> server   {"type":"start","source":"<C source>"}
                   {"type":"stdin","data":"10 20\n"}
                   {"type":"stop"}

server -> client   {"type":"status","state":"compiling"|"running"}
                   {"type":"stdout"|"stderr","data":"..."}
                   {"type":"input_required"}
                   {"type":"exit","code":0,"phase":"compile"|"run"}
                   {"type":"error","message":"..."}
```

The program runs on a pty, so an unflushed prompt such as
`printf("Enter a number: ")` reaches the user before the program blocks.
`input_required` is sent when the process is actually blocked reading stdin
(checked via `/proc/<pid>/syscall`), so a busy program is not mistaken for one
awaiting input. Compiler diagnostics arrive as `stderr`, with the server's
temporary path stripped so errors read `program.c:4:5: ...`.

Build flags: `-std=c11 -O1 -Wall -Wextra -fstack-protector-strong
-D_FORTIFY_SOURCE=2`, linked with `-lm`.

#### Limits

| limit | value |
| --- | --- |
| gcc wall clock | 20s |
| program CPU | 5s (`RLIMIT_CPU`) |
| program wall clock | 60s |
| address space | 256 MB |
| file writes | 8 MB (`RLIMIT_FSIZE`) |
| output streamed | 1 MB, then the program is killed |
| source accepted | 256 KB |
| `stop` | SIGTERM to the process group, SIGKILL after 2s |

Each run gets a private temp directory and a scrubbed environment; the
directory is removed when the socket closes.

#### Security

These limits are defence in depth, **not a sandbox**. A hostile program can
still read world-readable files and open network connections. Running
untrusted C safely needs OS-level isolation — a container with a seccomp
profile, no network namespace, and an unprivileged user. Deploy it behind
that; `prefix.txt` asking the model to refuse unsafe programs is not a
security boundary.


## Repository files

| path | purpose |
| --- | --- |
| `main.py` | FastAPI endpoint, request handling, and local model-server client |
| `prefix.txt` | Prompt instructions prepended to each generation request |
| `.env` | Local ports and route configuration (not committed) |

## Limitations

- The backend only generates source code; it has no execution endpoint or
  WebSocket support.
- Generated C is returned as text and is not compiled, run, or sandboxed.
- CORS currently allows requests from any origin. This local development
  service should not be exposed to untrusted networks.
