"""GCC compilation and interactive execution of generated C programs.

This module is deliberately self-contained: it knows nothing about FastAPI or
WebSockets. It exposes two things to the app layer:

    compile_source(source)  -> CompileResult      (writes + invokes gcc)
    Execution(exe, workdir) -> async event stream (runs the binary)

There are two execution backends behind `Execution`:

    pty  (Linux, macOS)  The program runs on a pseudo-terminal under rlimits.
                         "Waiting for input" is read from /proc on Linux.
    pipe (Windows)       The program runs on plain pipes inside a Windows Job
                         Object. A tiny runtime shim, linked into every build,
                         turns off stdout buffering so prompts still arrive
                         before the program blocks. "Waiting for input" is
                         inferred: no output and no CPU use for a moment.

Set NLC_EXEC_MODE=pipe to use the pipe backend on Linux (for testing it).

SECURITY NOTE
-------------
The limits applied here (rlimits or a Job Object, timeouts, a scrubbed
environment, a private working directory) are defence in depth, NOT a sandbox.
A hostile program can still read files the server's user can read and open
network connections. Running untrusted C safely needs OS-level isolation -- a
container or VM with no network and an unprivileged user. Deploy this behind
that.
"""

from __future__ import annotations

import asyncio
import ctypes
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp

IS_WINDOWS = sys.platform == "win32"

if not IS_WINDOWS:
    # POSIX only. Windows has none of these; the pipe backend replaces them.
    import pty
    import resource
    import termios

EXEC_MODE = os.environ.get("NLC_EXEC_MODE") or ("pipe" if IS_WINDOWS else "pty")
if EXEC_MODE not in ("pty", "pipe") or (IS_WINDOWS and EXEC_MODE == "pty"):
    raise RuntimeError(f"Unsupported NLC_EXEC_MODE={EXEC_MODE!r} on {sys.platform}")

# --- knobs ----------------------------------------------------------------

# Where gcc lives, in this order: NLC_GCC, PATH, then (on Windows) the folders
# MSYS2 and MinGW install to, so a fresh MSYS2 install works without PATH edits.
_WINDOWS_GCC_GUESSES = (
    r"C:\msys64\ucrt64\bin\gcc.exe",
    r"C:\msys64\mingw64\bin\gcc.exe",
    r"C:\mingw64\bin\gcc.exe",
    r"C:\MinGW\bin\gcc.exe",
)


def _find_gcc() -> str:
    explicit = os.environ.get("NLC_GCC")
    if explicit:
        return explicit
    on_path = shutil.which("gcc")
    if on_path:
        return on_path
    if IS_WINDOWS:
        for guess in _WINDOWS_GCC_GUESSES:
            if os.path.isfile(guess):
                return guess
    return "gcc"


GCC = _find_gcc()

COMPILE_TIMEOUT_S = 20.0        # wall clock for gcc itself
RUN_WALL_TIMEOUT_S = 60.0       # running time; time spent waiting for input is not counted
RUN_SESSION_LIMIT_S = 900.0     # absolute cap, input waits included, so nothing runs forever
RUN_CPU_SECONDS = 5             # RLIMIT_CPU, SIGKILL on overrun
MEMORY_BYTES = 256 * 1024 * 1024
FSIZE_BYTES = 8 * 1024 * 1024   # largest file the program may write
MAX_OUTPUT_BYTES = 1024 * 1024  # cumulative stdout+stderr before we cut it off
MAX_SOURCE_BYTES = 256 * 1024
STOP_GRACE_S = 2.0              # SIGTERM -> SIGKILL window

# How long the program must sit idle before we decide it wants input.
IDLE_PROBE_S = 0.12
# Pipe backend only: quiet time before a blocked, non-busy program counts as
# waiting for input, and the CPU use per probe that counts as "busy".
PIPE_IDLE_PROMPT_S = 0.25
PIPE_BUSY_CPU_S = 0.02

# _GNU_SOURCE keeps C11 but exposes common library extras such as M_PI and
# strdup, which strict -std=c11 hides on both glibc and MinGW.
GCC_FLAGS = ["-std=c11", "-D_GNU_SOURCE", "-O1", "-pipe", "-Wall"]
if IS_WINDOWS:
    # MinGW: link statically so the program needs no MinGW DLLs on PATH. The
    # hardening flags below need libssp on many MinGW builds, so they are
    # Linux/macOS only.
    GCC_FLAGS += ["-static"]
else:
    GCC_FLAGS += ["-fstack-protector-strong", "-D_FORTIFY_SOURCE=2"]
LINK_FLAGS = ["-lm"]

SOURCE_NAME = "program.c"
BINARY_NAME = "program.exe" if IS_WINDOWS else "program"
RUNTIME_SHIM_NAME = "nlc_runtime.c"

# Linked into pipe-mode builds only. Unbuffered stdout makes an unflushed
# prompt like printf("Enter a number: ") reach the user before the program
# blocks on input; on Windows, binary mode stops the CRT turning \n into \r\n.
RUNTIME_SHIM = r"""/* Added by the backend; not part of the generated program. */
#ifdef _WIN32
/* Older MinGW.org headers hide _setmode and _O_BINARY under -std=c11. */
#undef __STRICT_ANSI__
#endif
#include <stdio.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#ifndef _O_BINARY
#define _O_BINARY 0x8000
#endif
#endif

__attribute__((constructor)) static void nlc_runtime_init(void)
{
#ifdef _WIN32
    _setmode(0, _O_BINARY);
    _setmode(1, _O_BINARY);
    _setmode(2, _O_BINARY);
#endif
    setvbuf(stdout, NULL, _IONBF, 0);
}
"""


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
    if IS_WINDOWS:
        system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
        return {
            # Windows processes need SYSTEMROOT to initialise.
            "SYSTEMROOT": system_root,
            "PATH": os.path.join(system_root, "System32"),
            "TEMP": str(workdir),
            "TMP": str(workdir),
        }
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(workdir),
        "TMPDIR": str(workdir),
        "LANG": "C.UTF-8",
        "TERM": "dumb",
    }


def _gcc_env(workdir: Path) -> dict[str, str]:
    # MinGW's gcc finds its assembler, linker and DLLs through PATH, so on
    # Windows it gets the server's environment. gcc itself is trusted.
    if not IS_WINDOWS:
        return _child_env(workdir)
    env = dict(os.environ)
    gcc_dir = os.path.dirname(GCC)
    if gcc_dir:
        # gcc found in C:\msys64 (or via NLC_GCC) may not be on PATH; its
        # helpers (cc1, as, ld) need the DLLs in that same folder.
        path_key = next((k for k in env if k.upper() == "PATH"), "PATH")
        env[path_key] = gcc_dir + os.pathsep + env.get(path_key, "")
    return env


# --- compilation ----------------------------------------------------------


async def compile_source(source: str) -> CompileResult:
    """Write `source` to a private directory and build it with gcc."""
    workdir = Path(mkdtemp(prefix="nlc-"))
    src_path = workdir / SOURCE_NAME
    exe_path = workdir / BINARY_NAME

    # newline="\n": gcc reports the same line numbers either way, but keep the
    # file byte-identical to what the user wrote on every platform.
    src_path.write_text(source, encoding="utf-8", newline="\n")

    sources = [SOURCE_NAME]
    if EXEC_MODE == "pipe":
        (workdir / RUNTIME_SHIM_NAME).write_text(RUNTIME_SHIM, encoding="utf-8", newline="\n")
        sources.append(RUNTIME_SHIM_NAME)

    # Relative paths, run from workdir: diagnostics then read
    # "program.c:4:5: ..." with no server path to strip.
    argv = [GCC, *GCC_FLAGS, *sources, "-o", BINARY_NAME, *LINK_FLAGS]

    # subprocess in a worker thread rather than asyncio's subprocess support:
    # the latter is unavailable on some Windows event loops.
    def build() -> subprocess.CompletedProcess:
        return subprocess.run(
            argv,
            cwd=workdir,
            env=_gcc_env(workdir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=COMPILE_TIMEOUT_S,
        )

    try:
        result = await asyncio.to_thread(build)
    except subprocess.TimeoutExpired:
        return CompileResult(
            False, f"gcc timed out after {COMPILE_TIMEOUT_S:.0f}s.", None, workdir, -1
        )
    except FileNotFoundError:
        hint = (
            "Install MSYS2 from https://www.msys2.org/, then in the \"MSYS2 UCRT64\" window run: "
            "pacman -S mingw-w64-ucrt-x86_64-gcc  (the app finds C:\\msys64 by itself; "
            "for another location set NLC_GCC). Then restart the app."
            if IS_WINDOWS
            else "Install it (for example: sudo apt install gcc), then restart the app."
        )
        return CompileResult(False, f"gcc (the C compiler) was not found. {hint}\n", None, workdir, -1)
    except OSError as exc:
        return CompileResult(False, f"could not start gcc: {exc}\n", None, workdir, -1)

    diagnostics = result.stdout.decode("utf-8", "replace")
    ok = result.returncode == 0 and exe_path.exists()
    if result.returncode == 0 and not ok:
        diagnostics += (
            "gcc finished but the program file is missing. "
            "Antivirus software may have removed it.\n"
        )
    # Belt and braces: gcc may still print absolute paths (e.g. for headers).
    for prefix in (f"{workdir}{os.sep}", f"{workdir}/", str(workdir)):
        diagnostics = diagnostics.replace(prefix, "")

    return CompileResult(ok, diagnostics, exe_path if ok else None, workdir, result.returncode or 0)


# --- execution ------------------------------------------------------------


def _too_long_message() -> str:
    return (
        f"The program ran for more than {RUN_WALL_TIMEOUT_S:.0f}s "
        "(not counting time spent waiting for input) and was stopped."
    )


def _session_limit_message() -> str:
    return f"The program was stopped after {RUN_SESSION_LIMIT_S / 60:.0f} minutes."


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


class _PtyExecution:
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
        """Stop the program after RUN_WALL_TIMEOUT_S of running time.

        Time spent waiting for the user to type is not counted, so an
        interactive program is not killed while someone thinks. Separately,
        nothing runs longer than RUN_SESSION_LIMIT_S in total.
        """
        active = 0.0
        started = last = time.monotonic()
        while not self._finished.is_set():
            try:
                await asyncio.wait_for(self._finished.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                pass
            now = time.monotonic()
            if not self._prompted:
                active += now - last
            last = now
            if active > RUN_WALL_TIMEOUT_S or now - started > RUN_SESSION_LIMIT_S:
                message = _too_long_message() if active > RUN_WALL_TIMEOUT_S else _session_limit_message()
                await self._emit({"type": "error", "message": message})
                self._signal_group(signal.SIGKILL)
                return


# --- pipe backend (Windows; NLC_EXEC_MODE=pipe elsewhere) --------------------


# Windows Job Object limits. Field types are spelled out with fixed-width
# ctypes so the layout matches the Windows x64 ABI on any host (and can be
# checked on Linux).
class _IoCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_uint64)
        for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )
    ]


class _JobBasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),   # LARGE_INTEGER, 100 ns units
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),               # DWORD
        ("MinimumWorkingSetSize", ctypes.c_size_t),    # SIZE_T
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),                 # ULONG_PTR
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _JobExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobBasicLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_LIMIT_PROCESS_TIME = 0x0002
_JOB_LIMIT_ACTIVE_PROCESS = 0x0008
_JOB_LIMIT_PROCESS_MEMORY = 0x0100
_JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x0400   # no "stopped working" dialog
_JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

# Common NTSTATUS exit codes for a crashed Windows program.
_NTSTATUS_NAMES = {
    0xC0000005: "access violation (invalid memory access)",
    0xC0000094: "integer division by zero",
    0xC00000FD: "stack overflow",
    0xC0000409: "stack buffer overrun",
    0xC000001D: "illegal instruction",
    0xC0000017: "out of memory",
}


class _WindowsJob:
    """A Job Object holding the program: memory, CPU time and process-count
    limits, and the guarantee that closing the job kills the program."""

    def __init__(self, handle: int) -> None:
        self._handle = handle

    @classmethod
    def wrap(cls, proc: subprocess.Popen) -> "_WindowsJob | None":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32,
        ]
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            return None

        info = _JobExtendedLimits()
        basic = info.BasicLimitInformation
        basic.LimitFlags = (
            _JOB_LIMIT_PROCESS_TIME
            | _JOB_LIMIT_ACTIVE_PROCESS
            | _JOB_LIMIT_PROCESS_MEMORY
            | _JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
            | _JOB_LIMIT_KILL_ON_JOB_CLOSE
        )
        # Backstop only: the watcher in _PipeExecution stops the program at
        # RUN_CPU_SECONDS with a clear message; this fires a little later.
        basic.PerProcessUserTimeLimit = int((RUN_CPU_SECONDS + 2) * 10_000_000)
        basic.ActiveProcessLimit = 1          # the program may not start others
        info.ProcessMemoryLimit = MEMORY_BYTES

        ok = kernel32.SetInformationJobObject(
            handle, _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info), ctypes.sizeof(info),
        ) and kernel32.AssignProcessToJobObject(handle, int(proc._handle))
        if not ok:
            kernel32.CloseHandle(handle)
            return None
        return cls(handle)

    def kill(self) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.TerminateJobObject(self._handle, 1)

    def close(self) -> None:
        if self._handle:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel32.CloseHandle(self._handle)   # KILL_ON_JOB_CLOSE ends the program
            self._handle = 0


def _cpu_seconds(proc: subprocess.Popen) -> float | None:
    """CPU time (user + kernel) the process has used so far, or None."""
    if IS_WINDOWS:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.c_void_p] * 4
        created, exited, kernel, user = (ctypes.c_uint64() for _ in range(4))
        if not kernel32.GetProcessTimes(
            int(proc._handle), ctypes.byref(created), ctypes.byref(exited),
            ctypes.byref(kernel), ctypes.byref(user),
        ):
            return None
        return (kernel.value + user.value) / 10_000_000   # 100 ns units
    try:
        with open(f"/proc/{proc.pid}/stat", "r", encoding="ascii") as handle:
            fields = handle.read().rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError):
        return None


class _PipeExecution:
    """Runs a compiled binary on pipes and reports what it does.

    Same events and methods as _PtyExecution. Differences, all forced by
    Windows having no ptys, rlimits or /proc:

    - stdout is unbuffered by RUNTIME_SHIM rather than by a terminal;
    - "waiting for input" is inferred: the program is alive, has printed
      nothing for PIPE_IDLE_PROMPT_S, and is not using CPU. A program that
      sleeps without reading input can therefore look like it wants input;
    - limits come from a Job Object on Windows (rlimits elsewhere), and the CPU
      limit is also enforced by polling, so it holds even if the job fails;
    - stop terminates the program at once (Windows has no SIGTERM).

    Output is read by one thread per stream and handed to the event loop, so
    this works on any asyncio loop.
    """

    def __init__(self, exe_path: Path, workdir: Path) -> None:
        self.exe_path = exe_path
        self.workdir = workdir
        self.events: asyncio.Queue[dict] = asyncio.Queue()

        self._proc: subprocess.Popen | None = None
        self._job: _WindowsJob | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: list[asyncio.Task] = []
        self._streams_open = 0
        self._streams_closed = asyncio.Event()
        self._finished = asyncio.Event()
        self._last_activity = time.monotonic()
        self._prompted = False
        self._bytes_out = 0
        self._capped = False
        self._stop_reason: str | None = None

    # -- lifecycle --

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        kwargs: dict = dict(
            cwd=self.workdir,
            env=_child_env(self.workdir),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        if IS_WINDOWS:
            kwargs["creationflags"] = (
                subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            )
        else:
            kwargs["preexec_fn"] = _apply_limits
            kwargs["start_new_session"] = True

        self._proc = subprocess.Popen([str(self.exe_path)], **kwargs)
        if IS_WINDOWS:
            # The program runs for a moment before it joins the job; Popen
            # cannot start it suspended. Acceptable for these limits.
            self._job = _WindowsJob.wrap(self._proc)
            if self._job is None:
                await self._emit({
                    "type": "stderr",
                    "data": "[warning: could not apply memory/CPU limits; time limit still applies]\n",
                })

        self._last_activity = time.monotonic()
        for stream, kind in ((self._proc.stdout, "stdout"), (self._proc.stderr, "stderr")):
            self._streams_open += 1
            threading.Thread(target=self._read_stream, args=(stream, kind), daemon=True).start()

        self._tasks = [
            asyncio.create_task(self._wait_for_exit()),
            asyncio.create_task(self._watch()),
        ]

    async def send_input(self, data: str) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            return
        self._prompted = False
        self._last_activity = time.monotonic()
        payload = data.encode("utf-8", "replace")

        def write() -> None:
            view = memoryview(payload)
            while view:
                written = proc.stdin.write(view)
                view = view[written or 0:]

        try:
            await asyncio.to_thread(write)
        except (OSError, ValueError):
            pass  # program closed stdin or already gone

    async def stop(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            return
        self._kill()
        try:
            await asyncio.wait_for(self._finished.wait(), timeout=STOP_GRACE_S)
        except asyncio.TimeoutError:
            pass

    async def close(self) -> None:
        """Release everything. Safe to call more than once."""
        if self._proc is not None and self._proc.poll() is None:
            self._kill()
            try:
                await asyncio.wait_for(asyncio.to_thread(self._proc.wait), timeout=2.0)
            except asyncio.TimeoutError:
                pass

        for task in self._tasks:
            task.cancel()
        self._tasks.clear()

        if self._proc is not None:
            for stream in (self._proc.stdin, self._proc.stdout, self._proc.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except OSError:
                    pass
        if self._job is not None:
            self._job.close()
            self._job = None

        # Windows can hold the .exe open for a moment after the process dies.
        for _ in range(10):
            shutil.rmtree(self.workdir, ignore_errors=True)
            if not self.workdir.exists():
                break
            await asyncio.sleep(0.1)

    # -- internals --

    def _kill(self) -> None:
        if self._job is not None:
            self._job.kill()
        elif self._proc is not None:
            if not IS_WINDOWS:
                try:
                    os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
                    return
                except (ProcessLookupError, PermissionError, OSError):
                    pass
            try:
                self._proc.kill()
            except OSError:
                pass

    def _read_stream(self, stream, kind: str) -> None:
        """Worker thread: forward chunks to the event loop as they arrive."""
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                self._call_soon(self._on_output, kind, chunk)
        except (OSError, ValueError):
            pass
        finally:
            self._call_soon(self._on_stream_closed)

    def _call_soon(self, callback, *args) -> None:
        try:
            self._loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            pass  # loop already closed; nothing is listening

    def _on_output(self, kind: str, chunk: bytes) -> None:
        self._last_activity = time.monotonic()
        self._prompted = False
        if self._capped:
            return
        self._bytes_out += len(chunk)
        if self._bytes_out > MAX_OUTPUT_BYTES:
            self._capped = True
            self.events.put_nowait({
                "type": "error",
                "message": f"Output exceeded {MAX_OUTPUT_BYTES // 1024} KB; the program was stopped.",
            })
            self._kill()
            return
        self.events.put_nowait({"type": kind, "data": chunk.decode("utf-8", "replace")})

    def _on_stream_closed(self) -> None:
        self._streams_open -= 1
        if self._streams_open <= 0:
            self._streams_closed.set()

    async def _emit(self, event: dict) -> None:
        await self.events.put(event)

    async def _watch(self) -> None:
        """Detect input waits, and enforce CPU and wall-clock limits."""
        active = 0.0                      # running time, excluding input waits
        started = last_tick = time.monotonic()
        last_cpu = _cpu_seconds(self._proc)
        while self._proc.poll() is None:
            await asyncio.sleep(IDLE_PROBE_S)
            if self._proc.poll() is not None:
                return

            cpu = _cpu_seconds(self._proc)
            busy = cpu is not None and last_cpu is not None and cpu - last_cpu > PIPE_BUSY_CPU_S
            last_cpu = cpu if cpu is not None else last_cpu

            if cpu is not None and cpu > RUN_CPU_SECONDS:
                self._stop_reason = f"The program used more than {RUN_CPU_SECONDS}s of CPU time and was stopped."
                self._kill()
                return
            now = time.monotonic()
            if not self._prompted:
                active += now - last_tick
            last_tick = now
            if active > RUN_WALL_TIMEOUT_S or now - started > RUN_SESSION_LIMIT_S:
                # On Windows a sleeping program looks like one waiting for
                # input, so the session limit is what eventually stops it.
                self._stop_reason = (
                    _too_long_message() if active > RUN_WALL_TIMEOUT_S else _session_limit_message()
                )
                self._kill()
                return

            quiet = time.monotonic() - self._last_activity >= PIPE_IDLE_PROMPT_S
            if quiet and not busy and not self._prompted:
                self._prompted = True
                await self._emit({"type": "input_required"})

    async def _wait_for_exit(self) -> None:
        code = await asyncio.to_thread(self._proc.wait)
        self._finished.set()

        # Let the reader threads hand over whatever output is still in flight.
        try:
            await asyncio.wait_for(self._streams_closed.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass

        if self._stop_reason:
            await self._emit({"type": "error", "message": self._stop_reason})

        if IS_WINDOWS:
            status = code & 0xFFFFFFFF
            if status in _NTSTATUS_NAMES:
                await self._emit({
                    "type": "stderr",
                    "data": f"\n[program crashed: {_NTSTATUS_NAMES[status]} (0x{status:08X})]\n",
                })
        elif code < 0:
            sig = -code
            name = signal.Signals(sig).name if sig in set(signal.Signals) else str(sig)
            await self._emit({"type": "stderr", "data": f"\n[program terminated by {name}]\n"})
            code = 128 + sig

        await self._emit({"type": "exit", "code": code, "phase": "run"})


Execution = _PipeExecution if EXEC_MODE == "pipe" else _PtyExecution
