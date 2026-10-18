import asyncio
import os
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from compiler import MAX_SOURCE_BYTES, Execution, compile_source

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

COMPILE_ROUTE = os.environ["COMPILE_ROUTE"]
WS_RUN_ROUTE = os.environ.get("WS_RUN_ROUTE", "/ws/run")
SERVER_PORT = int(os.environ["SERVER_PORT"])
LLAMA_PORT = int(os.environ["LLAMA_PORT"])

LLAMA_URL = f"http://127.0.0.1:{LLAMA_PORT}/v1/chat/completions"
MODEL = "Qwen3-4B-Q4_K_M.gguf"
TEMPERATURE = 0.1
DELIMITER = "\nNL_CODE_START\n"

PREFIX = (BASE_DIR / "prefix.txt").read_text(encoding="utf-8")


class NLLine(BaseModel):
    line: int
    text: str


class CompileRequest(BaseModel):
    """Body the frontend sends: {"nl_code": [{"line": 1, "text": "..."}]}."""

    nl_code: list[NLLine]


app = FastAPI()


@app.exception_handler(RequestValidationError)
async def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
    # The frontend reads `error` from failure bodies; FastAPI's default is `detail`.
    return JSONResponse(
        status_code=422,
        content={"error": "Request body must be {\"nl_code\": [{\"line\": int, \"text\": str}]}."},
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post(COMPILE_ROUTE)
async def compile_nl(request: CompileRequest):
    lines = request.nl_code
    nl_code = "\n".join(f"{l.line}. {l.text}" for l in sorted(lines, key=lambda l: l.line))
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PREFIX + DELIMITER + nl_code}],
        "temperature": TEMPERATURE,
    }

    try:
        # No timeout: generation time depends on model load and output length.
        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.post(LLAMA_URL, json=payload)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"llama.cpp request failed: {e!r}")
        return JSONResponse(status_code=500, content={"error": "llama.cpp server is down"})

    # Placeholder: display the generated output.
    print(content)
    # `output` is passed through verbatim; the frontend treats a value starting
    # with "ERROR:" (prefix.txt's rejection format) as an error, not as code.
    return {"output": content}


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
            # Warnings on success, errors on failure: both belong on stderr.
            await websocket.send_json({"type": "stderr", "data": result.diagnostics})

        if not result.ok:
            await websocket.send_json(
                {"type": "exit", "code": result.exit_code or 1, "phase": "compile"}
            )
            return

        # --- run ---
        await websocket.send_json({"type": "status", "state": "running"})
        execution = Execution(result.exe_path, result.workdir)
        workdir = None  # Execution.close() owns the directory from here on
        await execution.start()

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
            import shutil

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
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT)
