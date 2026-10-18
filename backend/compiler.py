"""GCC compilation and interactive execution of generated C programs.

This module is deliberately self-contained: it knows nothing about FastAPI or
WebSockets. It exposes two things to the app layer:

    compile_source(source)  -> CompileResult      (writes + invokes gcc)
    Execution(exe, workdir) -> async event stream (runs the binary)

SECURITY NOTE
-------------
The limits applied here (rlimits, timeouts, a scrubbed environment, a private
working directory) are defence in depth, NOT a sandbox. A hostile program can
still read world-readable files and open sockets. Running untrusted C safely
needs OS-level isolation -- a container with a seccomp profile, a dropped
network namespace and a non-privileged user. Deploy this behind that.
"""

from __future__ import annotations

import asyncio
import os
import pty
import resource
import shutil
import signal
import termios
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp

# --- knobs ----------------------------------------------------------------

GCC = shutil.which("gcc") or "gcc"

COMPILE_TIMEOUT_S = 20.0        # wall clock for gcc itself
RUN_WALL_TIMEOUT_S = 60.0       # wall clock for the compiled program
RUN_CPU_SECONDS = 5             # RLIMIT_CPU, SIGKILL on overrun
MEMORY_BYTES = 256 * 1024 * 1024
FSIZE_BYTES = 8 * 1024 * 1024   # largest file the program may write
MAX_OUTPUT_BYTES = 1024 * 1024  # cumulative stdout+stderr before we cut it off
MAX_SOURCE_BYTES = 256 * 1024
STOP_GRACE_S = 2.0              # SIGTERM -> SIGKILL window

# How long the program must sit idle before we decide it wants input.
IDLE_PROBE_S = 0.12

GCC_FLAGS = [
    "-std=c11",
    "-O1",
    "-pipe",
    "-Wall",
    "-Wextra",
    "-fstack-protector-strong",
    "-D_FORTIFY_SOURCE=2",
]
LINK_FLAGS = ["-lm"]

SOURCE_NAME = "program.c"
BINARY_NAME = "program"


@dataclass
class CompileResult:
    ok: bool
    diagnostics: str        # gcc stdout+stderr, verbatim
    exe_path: Path | None
    workdir: Path
    exit_code: int


def _apply_limits() -> None:
    """Run in the child between fork and exec."""
    resource.setrlimit(resource.RLIMIT_CPU, (RUN_CPU_SECONDS, RUN_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_BYTES, FSIZE_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        # Cheap fork-bomb brake. Best effort: the limit is per real UID, so it
        # can fail or be meaningless depending on how the server runs.
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    except (ValueError, OSError):
        pass


def _child_env(workdir: Path) -> dict[str, str]:
    """A scrubbed environment: the program sees nothing of the server's."""
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(workdir),
        "TMPDIR": str(workdir),
        "LANG": "C.UTF-8",
        "TERM": "dumb",
    }


# --- compilation ----------------------------------------------------------


async def compile_source(source: str) -> CompileResult:
    """Write `source` to a private directory and build it with gcc."""
    workdir = Path(mkdtemp(prefix="nlc-"))
    src_path = workdir / SOURCE_NAME
    exe_path = workdir / BINARY_NAME

    src_path.write_text(source, encoding="utf-8")

    argv = [GCC, *GCC_FLAGS, str(src_path), "-o", str(exe_path), *LINK_FLAGS]

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=workdir,
            env=_child_env(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        return CompileResult(False, f"could not start gcc: {exc}", None, workdir, -1)

    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=COMPILE_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return CompileResult(
            False,
            f"gcc timed out after {COMPILE_TIMEOUT_S:.0f}s.",
            None,
            workdir,
            -1,
        )

    diagnostics = out.decode("utf-8", "replace")
    ok = proc.returncode == 0 and exe_path.exists()
    # Strip the temp path so the user sees "program.c:4:5: error: ..."
    diagnostics = diagnostics.replace(f"{workdir}/", "").replace(str(workdir), "")

    return CompileResult(ok, diagnostics, exe_path if ok else None, workdir, proc.returncode or 0)


# --- execution ------------------------------------------------------------


def _waiting_for_stdin(pid: int) -> bool:
    """True when the process is blocked in read() on fd 0.

    Reads /proc/<pid>/syscall, whose first field is the syscall number and
    whose second is the first argument. On Linux/x86-64, read() is 0. If the
    file cannot be read we fall back to True, matching the plain idle
    heuristic rather than hanging the UI forever.
    """
    try:
        with open(f"/proc/{pid}/syscall", "r", encoding="ascii") as handle:
            fields = handle.read().split()
    except (OSError, ValueError):
        return True

    if not fields or fields[0] == "running":
        return False
    try:
        syscall_nr = int(fields[0])
        fd = int(fields[1], 16)
    except (IndexError, ValueError):
        return True
    return syscall_nr == 0 and fd == 0


class Execution:
    """Runs a compiled binary on a pty and reports what it does.

    A pty (rather than a pipe) matters: C's stdout is fully buffered when it
    is not a terminal, so `printf("Enter a number: ")` with no newline would
    never reach the user before the program blocked on input. On a pty it is
    line buffered and arrives immediately. Terminal echo is switched off so
    the UI's own echo of submitted input is not duplicated.

    stderr stays on its own pipe so it can be reported as stderr; C leaves it
    unbuffered, so nothing is lost by keeping it off the pty.
    """

    def __init__(self, exe_path: Path, workdir: Path) -> None:
        self.exe_path = exe_path
        self.workdir = workdir
        self.events: asyncio.Queue[dict] = asyncio.Queue()

        self._proc: asyncio.subprocess.Process | None = None
        self._write_fd: int | None = None
        self._master_file = None
        self._tasks: list[asyncio.Task] = []
        self._bytes_out = 0
        self._capped = False
        self._prompted = False       # input_required already sent for this pause
        self._finished = asyncio.Event()

    # -- lifecycle --

    async def start(self) -> None:
        master_fd, slave_fd = pty.openpty()

        attrs = termios.tcgetattr(slave_fd)
        attrs[3] &= ~termios.ECHO          # lflag: the UI echoes input itself
        attrs[1] &= ~termios.OPOST         # oflag: no \n -> \r\n translation
        termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)

        self._write_fd = os.dup(master_fd)

        self._proc = await asyncio.create_subprocess_exec(
            str(self.exe_path),
            cwd=self.workdir,
            env=_child_env(self.workdir),
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=asyncio.subprocess.PIPE,
            preexec_fn=_apply_limits,
            start_new_session=True,        # own process group, so we can kill the tree
        )
        os.close(slave_fd)

        self._master_file = os.fdopen(master_fd, "rb", 0)

        self._tasks = [
            asyncio.create_task(self._pump_pty()),
            asyncio.create_task(self._pump_stderr()),
            asyncio.create_task(self._wait_for_exit()),
            asyncio.create_task(self._enforce_wall_clock()),
        ]

    async def send_input(self, data: str) -> None:
        if self._write_fd is None or self._proc is None or self._proc.returncode is not None:
            return
        self._prompted = False
        try:
            os.write(self._write_fd, data.encode("utf-8", "replace"))
        except OSError:
            pass  # program closed stdin or already gone

    async def stop(self) -> None:
        """SIGTERM the process group, then SIGKILL if it lingers."""
        if self._proc is None or self._proc.returncode is not None:
            return
        self._signal_group(signal.SIGTERM)
        try:
            await asyncio.wait_for(self._finished.wait(), timeout=STOP_GRACE_S)
        except asyncio.TimeoutError:
            self._signal_group(signal.SIGKILL)

    async def close(self) -> None:
        """Release everything. Safe to call more than once."""
        if self._proc is not None and self._proc.returncode is None:
            self._signal_group(signal.SIGKILL)
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass

        for task in self._tasks:
            task.cancel()
        self._tasks.clear()

        for closer in (self._master_file, self._write_fd):
            try:
                if closer is self._write_fd and self._write_fd is not None:
                    os.close(self._write_fd)
                elif closer is not None:
                    closer.close()
            except OSError:
                pass
        self._master_file = None
        self._write_fd = None

        shutil.rmtree(self.workdir, ignore_errors=True)

    # -- internals --

    def _signal_group(self, sig: int) -> None:
        if self._proc is None or self._proc.pid is None:
            return
        try:
            os.killpg(os.getpgid(self._proc.pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                self._proc.send_signal(sig)
            except (ProcessLookupError, OSError):
                pass

    async def _emit(self, event: dict) -> None:
        await self.events.put(event)

    async def _emit_output(self, kind: str, data: bytes) -> None:
        if self._capped:
            return
        self._bytes_out += len(data)
        if self._bytes_out > MAX_OUTPUT_BYTES:
            self._capped = True
            await self._emit(
                {
                    "type": "error",
                    "message": f"Output exceeded {MAX_OUTPUT_BYTES // 1024} KB; the program was stopped.",
                }
            )
            self._signal_group(signal.SIGKILL)
            return
        await self._emit({"type": kind, "data": data.decode("utf-8", "replace")})

    async def _pump_pty(self) -> None:
        """Stream stdout, and notice when the program pauses for input.

        The pty is drained by an add_reader callback rather than a blocking
        read in a thread: a thread blocked in read() cannot be cancelled, so
        each idle probe would strand one holding the next chunk, and that
        chunk would be lost when its future was discarded.
        """
        loop = asyncio.get_running_loop()
        fd = self._master_file.fileno()
        os.set_blocking(fd, False)

        chunks: asyncio.Queue[bytes | None] = asyncio.Queue()

        def on_readable() -> None:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                return
            except OSError:
                data = b""          # EIO: the child closed the pty
            if not data:
                loop.remove_reader(fd)
                chunks.put_nowait(None)
            else:
                chunks.put_nowait(data)

        try:
            loop.add_reader(fd, on_readable)
        except (OSError, ValueError):
            return

        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(chunks.get(), timeout=IDLE_PROBE_S)
                except asyncio.TimeoutError:
                    # Quiet. Is it blocked on stdin, or just thinking?
                    if (
                        not self._prompted
                        and self._proc is not None
                        and self._proc.returncode is None
                        and _waiting_for_stdin(self._proc.pid)
                    ):
                        self._prompted = True
                        await self._emit({"type": "input_required"})
                    continue

                if chunk is None:
                    return
                self._prompted = False
                await self._emit_output("stdout", chunk)
        finally:
            try:
                loop.remove_reader(fd)
            except (OSError, ValueError):
                pass

    async def _pump_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        while True:
            try:
                chunk = await self._proc.stderr.read(4096)
            except (OSError, ValueError):
                return
            if not chunk:
                return
            await self._emit_output("stderr", chunk)

    async def _wait_for_exit(self) -> None:
        assert self._proc is not None
        code = await self._proc.wait()
        self._finished.set()

        # Let the readers drain whatever is still buffered in the pty.
        await asyncio.sleep(0.1)

        if code < 0:
            sig = -code
            name = signal.Signals(sig).name if sig in set(signal.Signals) else str(sig)
            await self._emit(
                {"type": "stderr", "data": f"\n[program terminated by {name}]\n"}
            )
            code = 128 + sig

        await self._emit({"type": "exit", "code": code, "phase": "run"})

    async def _enforce_wall_clock(self) -> None:
        try:
            await asyncio.wait_for(self._finished.wait(), timeout=RUN_WALL_TIMEOUT_S)
        except asyncio.TimeoutError:
            await self._emit(
                {
                    "type": "error",
                    "message": f"The program ran longer than {RUN_WALL_TIMEOUT_S:.0f}s and was stopped.",
                }
            )
            self._signal_group(signal.SIGKILL)
