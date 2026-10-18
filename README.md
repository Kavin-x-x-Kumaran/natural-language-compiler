# natural-language-compiler
A self-hosted web-based natural-language-compiler using Qwen AI using llama.cpp.

## Running C: `WS /ws/run`

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

### Limits

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

### Security

These limits are defence in depth, **not a sandbox**. A hostile program can
still read world-readable files and open network connections. Running
untrusted C safely needs OS-level isolation — a container with a seccomp
profile, no network namespace, and an unprivileged user. Deploy it behind
that; `prefix.txt` asking the model to refuse unsafe programs is not a
security boundary.
