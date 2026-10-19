# Natural language compiler — backend

FastAPI service that turns numbered natural-language instructions into C
source using a local `llama.cpp` server and the Qwen3-4B model. It implements
the frontend's HTTP generation endpoint, and compiles and runs the generated C
with gcc over `WS /ws/run` (see the root [`README.md`](../README.md)).

## Setup

You need `gcc` on the `PATH` and a Linux host: execution uses ptys and
`/proc`. From the repository root, install the Python dependencies:

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
| `WS_RUN_ROUTE` | no | `/ws/run` | WebSocket path for compiling and running C |

These variables are loaded from `backend/.env` or the process environment.
The first three have no code defaults and must be set. The model name,
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

Errors return `{ "error": "..." }`, the field the frontend displays. Invalid
request data gets a `422`; if the `llama.cpp` request fails, the API returns
`500` with `llama.cpp server is down`. Generation has no request timeout because duration
depends on model loading and output length.

## Repository files

| path | purpose |
| --- | --- |
| `main.py` | FastAPI endpoints, request handling, and local model-server client |
| `compiler.py` | gcc compilation and interactive execution for `/ws/run` |
| `prefix.txt` | Prompt instructions prepended to each generation request |
| `.env` | Local ports and route configuration (not committed) |

## Limitations

- Execution limits (CPU, memory, output, wall clock) are defence in depth,
  **not a sandbox**. Run the backend inside OS-level isolation before exposing
  it to anyone else; see the root `README.md`.
- CORS currently allows requests from any origin. This local development
  service should not be exposed to untrusted networks.
