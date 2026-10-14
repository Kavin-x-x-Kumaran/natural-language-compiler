import os
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

COMPILE_ROUTE = os.environ["COMPILE_ROUTE"]
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


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post(COMPILE_ROUTE)
async def compile_nl(lines: list[NLLine]):
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
        raise HTTPException(status_code=500, detail="llama.cpp server is down")

    # Placeholder: display the generated output.
    print(content)
    return {"code": content}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT)
