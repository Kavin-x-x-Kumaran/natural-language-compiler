import asyncio
import os
import re
import shutil
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
# Load .env before importing compiler, which reads NLC_GCC / NLC_EXEC_MODE.
# Every setting has a default, so backend/.env is optional.
load_dotenv(BASE_DIR / ".env")

from compiler import GCC, MAX_SOURCE_BYTES, Execution, compile_source  # noqa: E402

COMPILE_ROUTE = os.environ.get("COMPILE_ROUTE", "/compile")
WS_RUN_ROUTE = os.environ.get("WS_RUN_ROUTE", "/ws/run")
SERVER_PORT = int(os.environ.get("SERVER_PORT", "8000"))
LLAMA_PORT = int(os.environ.get("LLAMA_PORT", "8080"))

LLAMA_URL = f"http://127.0.0.1:{LLAMA_PORT}/v1/chat/completions"
LLAMA_HEALTH_URL = f"http://127.0.0.1:{LLAMA_PORT}/health"
MODEL = "Qwen3-4B-Q4_K_M.gguf"

# Ollama is used when llama-server is not running. It runs in the background
# once installed, so there is nothing to start by hand.
OLLAMA_PORT = int(os.environ.get("OLLAMA_PORT", "11434"))
OLLAMA_URL = f"http://127.0.0.1:{OLLAMA_PORT}"
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "").strip()
# Which installed Ollama model to use, best first; otherwise the first one.
OLLAMA_PREFERENCE = ("qwen3:4b", "qwen2.5-coder", "qwen3", "qwen2.5", "qwen")
# prefix.txt is about 2,000 tokens; Ollama's default window can be smaller,
# and Ollama silently drops the start of a prompt that does not fit.
OLLAMA_CONTEXT = 8192

MODEL_DOWN_MESSAGE = (
    "The AI model is not running. Open Ollama, or start llama-server on port "
    f"{LLAMA_PORT} (see the README), then press Run again."
)
TEMPERATURE = 0.1
DELIMITER = "\nNL_CODE_START\n"

PREFIX = (BASE_DIR / "prefix.txt").read_text(encoding="utf-8")


class NLLine(BaseModel):
    line: int
    text: str


_THINK_BLOCK = re.compile(r"<think>.*?(?:</think>|\Z)", re.DOTALL | re.IGNORECASE)
# Fences only count at the start of a line, so ``` inside a C string is kept.
_FENCED_BLOCK = re.compile(r"^[ \t]*```[^\n`]*\n(.*?)(?:^[ \t]*```|\Z)", re.DOTALL | re.MULTILINE)
_ERROR_LINE = re.compile(r"ERROR:\s*[A-Z_]+\s*\|[^\n]*")


def clean_model_output(text: str | None) -> str:
    """Reduce the model's reply to what belongs in the C editor.

    Qwen3 may prepend its reasoning ("<think>...</think>") and small models
    often wrap code in markdown fences despite prefix.txt. Neither should reach
    gcc. A refusal is reduced to its "ERROR: CODE | reason" line, which the
    frontend shows as an error rather than as code.
    """
    text = text or ""
    if "</think>" in text.lower():
        text = text[text.lower().rindex("</think>") + len("</think>"):]
    text = _THINK_BLOCK.sub("", text).strip()

    unquoted = text.strip("`'\" \n")
    if unquoted.startswith("ERROR:"):
        match = _ERROR_LINE.match(unquoted)
        return match.group(0).strip() if match else unquoted.splitlines()[0].strip()

    fenced = _FENCED_BLOCK.search(text)
    if fenced:
        text = fenced.group(1)
    text = text.strip("\n")
    if not text.strip():
        return "ERROR: EMPTY_OUTPUT | The model returned no code. Press Run again."
    return text + "\n"


app = FastAPI()


@app.exception_handler(RequestValidationError)
async def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
    # The frontend reads `error` from failure bodies; FastAPI's default is `detail`.
    return JSONResponse(
        status_code=422,
        content={"error": "Request body must be a JSON array of {\"line\": int, \"text\": str}."},
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _pick_ollama_model(names: list[str]) -> str | None:
    if OLLAMA_MODEL:
        return OLLAMA_MODEL
    for wanted in OLLAMA_PREFERENCE:
        for name in names:
            if name.startswith(wanted):
                return name
    return names[0] if names else None


async def find_model_server() -> tuple[str, str, bool] | None:
    """Which model server to use: (kind, model, ready), or None if none is running.

    llama-server (the README's setup) wins; Ollama is the fallback.
    """
    # trust_env=False: both servers are local, so never route via a proxy.
    async with httpx.AsyncClient(timeout=1.5, trust_env=False) as client:
        try:
            status = (await client.get(LLAMA_HEALTH_URL)).status_code
            if status in (200, 503):  # 503: running, model still loading
                return ("llama-server", MODEL, status == 200)
        except httpx.HTTPError:
            pass
        try:
            tags = (await client.get(f"{OLLAMA_URL}/api/tags")).json()
            name = _pick_ollama_model([m["name"] for m in tags.get("models") or []])
            if name:
                return ("Ollama", name, True)
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
            pass
    return None


@app.post(COMPILE_ROUTE)
async def compile_nl(lines: list[NLLine]):
    nl_code = "\n".join(f"{l.line}. {l.text}" for l in sorted(lines, key=lambda l: l.line))
    messages = [{"role": "user", "content": PREFIX + DELIMITER + nl_code}]

    server = await find_model_server()
    if server is None:
        return JSONResponse(status_code=503, content={"error": MODEL_DOWN_MESSAGE})
    kind, model, _ = server
    if kind == "Ollama":
        url = f"{OLLAMA_URL}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": TEMPERATURE, "num_ctx": OLLAMA_CONTEXT},
            # Keep the model in memory between Runs (Ollama's default is 5 min).
            "keep_alive": "1h",
        }
        if model.startswith("qwen3"):
            payload["think"] = False  # see the llama-server note below
    else:
        url = LLAMA_URL
        payload = {
            "model": model,
            "messages": messages,
            "temperature": TEMPERATURE,
            # Qwen3 "thinks" before answering by default, which is slow on a
            # laptop CPU and adds nothing here. Builds that ignore this kwarg
            # are handled by clean_model_output.
            "chat_template_kwargs": {"enable_thinking": False},
        }

    try:
        # No read timeout: generation time depends on the PC and output length.
        timeout = httpx.Timeout(None, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            response = await client.post(url, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return JSONResponse(status_code=503, content={"error": MODEL_DOWN_MESSAGE})
    except httpx.HTTPError as e:
        print(f"{kind} request failed: {e!r}")
        return JSONResponse(
            status_code=502, content={"error": f"Could not get an answer from {kind}: {e}"}
        )

    if response.status_code >= 400:
        try:
            error = response.json()["error"]
            detail = error["message"] if isinstance(error, dict) else error
        except (ValueError, KeyError, TypeError):
            detail = response.text[:200] or response.reason_phrase
        if response.status_code == 503 and "load" in str(detail).lower():
            message = "The AI model is still loading. Wait a few seconds, then press Run again."
        else:
            message = f"{kind} returned an error: {detail}"
        return JSONResponse(status_code=502, content={"error": message})

    try:
        data = response.json()
        if kind == "Ollama":
            content = data["message"]["content"]
            cut_off = data.get("done_reason") == "length"
        else:
            choice = data["choices"][0]
            content = choice["message"]["content"]
            cut_off = choice.get("finish_reason") == "length"
    except (ValueError, KeyError, IndexError, TypeError):
        return JSONResponse(
            status_code=502, content={"error": f"{kind} sent a reply the backend could not read."}
        )
    if cut_off:
        return {"code": "ERROR: OUTPUT_TOO_LONG | The answer was cut off. Try fewer or simpler steps."}

    # The frontend treats a value starting with "ERROR:" (prefix.txt's
    # rejection format) as an error, not as code.
    return {"code": clean_model_output(content)}


@app.get("/health")
async def health() -> dict:
    """Used by the frontend's status chip: is the backend up, is the model up?"""
    server = await find_model_server()
    model_ok = server is not None and server[2]
    return {
        "backend": "ok",
        "model": "ok" if model_ok else "down",
        "model_server": f"{server[0]} ({server[1]})" if server else None,
        "gcc": GCC,
    }


@app.get("/")
async def root() -> dict:
    return {"status": "backend running", "app": "open http://localhost:5173"}


@app.websocket(WS_RUN_ROUTE)
async def run_program(websocket: WebSocket) -> None:
    """Compile C with gcc and run it, streaming the session to the client.

    client -> server   {"type": "start",  "source": "<C source>"}
                       {"type": "stdin",  "data": "10 20\\n"}
                       {"type": "stop"}

    server -> client   {"type": "status", "state": "compiling" | "running"}
                       {"type": "stdout" | "stderr", "data": "..."}
                       {"type": "input_required"}
                       {"type": "exit",   "code": 0, "phase": "compile" | "run"}
                       {"type": "error",  "message": "..."}
    """
    await websocket.accept()

    execution: Execution | None = None
    workdir = None

    try:
        first = await websocket.receive_json()
        if not isinstance(first, dict) or first.get("type") != "start":
            await websocket.send_json(
                {"type": "error", "message": "Expected a start message."}
            )
            return

        source = first.get("source")
        if not isinstance(source, str) or not source.strip():
            await websocket.send_json(
                {"type": "error", "message": "No C source was provided."}
            )
            return
        if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
            await websocket.send_json(
                {
                    "type": "error",
                    "message": f"Source is larger than {MAX_SOURCE_BYTES // 1024} KB.",
                }
            )
            return

        # --- compile ---
        await websocket.send_json({"type": "status", "state": "compiling"})
        result = await compile_source(source)
        workdir = result.workdir

        if result.diagnostics.strip():
            text = result.diagnostics
            if result.ok:
                text = "gcc warnings (the program still compiled):\n" + text
            await websocket.send_json({"type": "stderr", "data": text})

        if not result.ok:
            await websocket.send_json(
                {"type": "exit", "code": result.exit_code or 1, "phase": "compile"}
            )
            return

        # --- run ---
        await websocket.send_json({"type": "status", "state": "running"})
        execution = Execution(result.exe_path, result.workdir)
        workdir = None  # Execution.close() owns the directory from here on
        try:
            await execution.start()
        except OSError as exc:
            await websocket.send_json({
                "type": "error",
                "message": f"Could not start the compiled program ({exc}). "
                "Antivirus software may be blocking it.",
            })
            return

        await _pump_session(websocket, execution)

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # never let a crash leave the socket hanging
        print(f"/ws/run failed: {exc!r}")
        try:
            await websocket.send_json(
                {"type": "error", "message": "The server failed while running your program."}
            )
        except Exception:
            pass
    finally:
        if execution is not None:
            await execution.close()
        elif workdir is not None:
            shutil.rmtree(workdir, ignore_errors=True)


async def _pump_session(websocket: WebSocket, execution: Execution) -> None:
    """Shuttle program events to the client and client input to the program."""

    async def to_client() -> None:
        while True:
            event = await execution.events.get()
            await websocket.send_json(event)
            if event.get("type") == "exit":
                return

    async def from_client() -> None:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "stdin":
                await execution.send_input(str(message.get("data", "")))
            elif kind == "stop":
                await execution.stop()

    sender = asyncio.create_task(to_client())
    receiver = asyncio.create_task(from_client())

    done, pending = await asyncio.wait(
        {sender, receiver}, return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    for task in done:
        exc = task.exception()
        if exc is not None and not isinstance(exc, WebSocketDisconnect):
            raise exc


if __name__ == "__main__":
    print(f"Backend running on http://127.0.0.1:{SERVER_PORT}  (gcc: {GCC})", flush=True)
    # Quiet logs: the UI checks /health every few seconds, and per-request
    # lines would bury anything useful. Warnings and errors still show.
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT, access_log=False, log_level="warning")
