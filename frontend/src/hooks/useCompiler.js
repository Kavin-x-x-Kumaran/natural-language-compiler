import { useCallback, useEffect, useRef, useState } from 'react';
import { buildPayload } from '../utils/buildPayload.js';
import { terminalReducer } from '../utils/terminalReducer.js';
import { MAX_LINES, STOP_TIMEOUT_MS } from '../utils/constants.js';
import { checkHealth, generateCode } from '../services/api.js';
import { startRun } from '../services/websocket.js';
import { MOCK_ENABLED } from '../services/endpoints.js';

const ACTIVE_EXEC = new Set(['connecting', 'compiling', 'running', 'waiting_input', 'stopping']);

/** True while an execution occupies the tab. */
export const isExecActive = (status) => ACTIVE_EXEC.has(status);

const mockTag = (text) => (MOCK_ENABLED ? `[mock] ${text}` : text);

const HEALTH_POLL_MS = 10000;

/** "ERROR: INVALID_INPUT | The request is empty." -> the readable reason. */
// Plain-English text for each refusal code in backend/prefix.txt, used when
// the model leaves out the reason after "|".
const REFUSALS = {
  INVALID_INPUT: 'the steps do not describe a programming task.',
  AMBIGUOUS_REQUIREMENTS: 'the steps are unclear or contradict each other. Add more detail.',
  PROMPT_INJECTION:
    'it thought the steps try to change its instructions. If they describe an ordinary program, press Run again or reword them.',
  UNSAFE_OPERATION: 'the program would do something harmful.',
  SERVER_RISK: 'the program could harm or overload the computer it runs on.',
};

const refusalReason = (output) => {
  const code = (output.match(/^ERROR:\s*([A-Z_]+)/) || [])[1];
  if (code === 'PROMPT_INJECTION') return REFUSALS[code];
  const reason = output.split('|').slice(1).join('|').trim();
  return reason || REFUSALS[code] || output.replace(/^ERROR:\s*/, '');
};

/**
 * Generation + execution state machine, per tab.
 *
 * Every terminal write and every status change goes through the tab's current
 * `exec.sessionId`, so events from a finished run can never overwrite a newer
 * one, and results always land in the tab that started them.
 */
export function useCompiler({ updateTab, tabsRef }) {
  // 'checking' until the first health check answers; then 'ready',
  // 'model-offline' (backend up, no AI model) or 'disconnected'.
  const [connection, setConnection] = useState(MOCK_ENABLED ? 'mock' : 'checking');

  const abortControllers = useRef(new Map()); // tabId -> AbortController
  const handles = useRef(new Map()); // tabId -> run handle
  const stopTimers = useRef(new Map()); // tabId -> timeout id
  const sessionCounters = useRef(new Map()); // tabId -> last session number

  const refreshHealth = useCallback(async () => {
    if (MOCK_ENABLED) return;
    setConnection(await checkHealth());
  }, []);

  // Ask the backend how things are on load and every few seconds, so the
  // chip is right before anyone presses a button.
  useEffect(() => {
    if (MOCK_ENABLED) return undefined;
    refreshHealth();
    const timer = setInterval(refreshHealth, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  const markConnected = useCallback(() => {
    if (!MOCK_ENABLED) setConnection('ready');
  }, []);
  const markDisconnected = useCallback(() => {
    if (!MOCK_ENABLED) setConnection('disconnected');
  }, []);

  /** Append a terminal entry, dropping it when it belongs to a stale session. */
  const append = useCallback(
    (tabId, kind, text, sessionId = null) => {
      updateTab(tabId, (tab) => ({
        terminal: terminalReducer(tab.terminal, {
          type: 'append',
          kind,
          text,
          sessionId,
          currentSessionId: sessionId === null ? null : tab.exec.sessionId,
        }),
      }));
    },
    [updateTab]
  );

  const patchExec = useCallback(
    (tabId, sessionId, patch) => {
      updateTab(tabId, (tab) => {
        if (sessionId !== null && tab.exec.sessionId !== sessionId) return {};
        return { exec: { ...tab.exec, ...patch } };
      });
    },
    [updateTab]
  );

  const clearStopTimer = useCallback((tabId) => {
    const timer = stopTimers.current.get(tabId);
    if (timer) {
      clearTimeout(timer);
      stopTimers.current.delete(tabId);
    }
  }, []);

  const closeSocket = useCallback(
    (tabId) => {
      const handle = handles.current.get(tabId);
      if (handle) {
        handle.close();
        handles.current.delete(tabId);
      }
      clearStopTimer(tabId);
    },
    [clearStopTimer]
  );

  const abortGeneration = useCallback((tabId) => {
    const controller = abortControllers.current.get(tabId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(tabId);
    }
  }, []);

  /** Release every resource a tab holds (tab close). */
  const cleanupTab = useCallback(
    (tabId) => {
      abortGeneration(tabId);
      closeSocket(tabId);
      sessionCounters.current.delete(tabId);
    },
    [abortGeneration, closeSocket]
  );

  // Abort in-flight work on unmount; never leave dangling sockets or fetches.
  useEffect(
    () => () => {
      abortControllers.current.forEach((controller) => controller.abort());
      abortControllers.current.clear();
      handles.current.forEach((handle) => handle.close());
      handles.current.clear();
      stopTimers.current.forEach((timer) => clearTimeout(timer));
      stopTimers.current.clear();
    },
    []
  );

  const getTab = useCallback(
    (tabId) => (tabsRef.current || []).find((tab) => tab.id === tabId),
    [tabsRef]
  );

  const clearTerminal = useCallback(
    (tabId) => updateTab(tabId, { terminal: [] }),
    [updateTab]
  );

  /* ---------------------------------------------------------------- stage A */

  /**
   * Generate C code for a tab.
   * @returns {'needs-confirm'|'started'|'rejected'} — 'needs-confirm' means the
   * caller must show the overwrite dialog and call again with force: true.
   */
  const generate = useCallback(
    (tabId, { force = false } = {}) => {
      const tab = getTab(tabId);
      if (!tab) return 'rejected';
      if (tab.gen.status === 'generating') return 'rejected';

      const payload = buildPayload(tab.nlText);

      if (payload.length === 0) {
        append(tabId, 'error', 'Nothing to run. Write at least one line.');
        return 'rejected';
      }
      if (payload.length > MAX_LINES) {
        append(
          tabId,
          'error',
          `Too many lines: ${payload.length}. The limit is ${MAX_LINES} non-empty lines.`
        );
        return 'rejected';
      }
      if (tab.cEdited && tab.cCode.trim() && !force) return 'needs-confirm';

      const controller = new AbortController();
      abortGeneration(tabId);
      abortControllers.current.set(tabId, controller);

      updateTab(tabId, (current) => ({
        gen: { status: 'generating', error: null, durationMs: null },
        // A finished run's "Process finished" must not linger in the status bar.
        exec: isExecActive(current.exec.status)
          ? current.exec
          : { ...current.exec, status: 'idle', exitCode: null },
        terminal: terminalReducer(current.terminal, {
          type: 'append',
          kind: 'status',
          text: mockTag('Generating C code...'),
        }),
      }));

      const startedAt = Date.now();

      generateCode(payload, { signal: controller.signal })
        .then((output) => {
          abortControllers.current.delete(tabId);
          const durationMs = Date.now() - startedAt;
          markConnected();

          if (output.trimStart().startsWith('ERROR:')) {
            // The backend's documented rejection format. Never goes in the editor.
            updateTab(tabId, (current) => ({
              gen: { status: 'error', error: output, durationMs },
              terminal: terminalReducer(current.terminal, {
                type: 'append',
                kind: 'error',
                text: `The model could not turn these steps into C: ${refusalReason(output.trim())}`,
              }),
            }));
            return;
          }

          const seconds = (durationMs / 1000).toFixed(1);
          updateTab(tabId, (current) => {
            let terminal = terminalReducer(current.terminal, {
              type: 'append',
              kind: 'status',
              text: mockTag(`Code generated in ${seconds}s`),
            });
            terminal = terminalReducer(terminal, {
              type: 'append',
              kind: 'source',
              text: output,
            });
            return {
              cCode: output,
              cEdited: false,
              gen: { status: 'success', error: null, durationMs },
              terminal,
            };
          });
        })
        .catch((error) => {
          abortControllers.current.delete(tabId);
          if (error && error.name === 'AbortError') return; // cancelled on purpose
          const message = error?.message || 'Generation failed.';
          if (error?.network) markDisconnected();
          updateTab(tabId, (current) => ({
            gen: { status: 'error', error: message, durationMs: null },
            terminal: terminalReducer(current.terminal, {
              type: 'append',
              kind: 'error',
              text: message,
            }),
          }));
        });

      return 'started';
    },
    [append, abortGeneration, getTab, markConnected, markDisconnected, updateTab]
  );

  /* ---------------------------------------------------------------- stage B */

  const compileAndRun = useCallback(
    (tabId) => {
      const tab = getTab(tabId);
      if (!tab) return 'rejected';
      if (isExecActive(tab.exec.status)) return 'rejected';
      if (tab.gen.status === 'generating') return 'rejected';

      const source = tab.cCode;
      if (!source.trim()) {
        append(tabId, 'error', 'No C code to compile.');
        return 'rejected';
      }

      closeSocket(tabId);

      const sessionId = (sessionCounters.current.get(tabId) || 0) + 1;
      sessionCounters.current.set(tabId, sessionId);

      updateTab(tabId, (current) => {
        let terminal = terminalReducer(current.terminal, {
          type: 'append',
          kind: 'status',
          text: '─ New run ─',
        });
        terminal = terminalReducer(terminal, {
          type: 'append',
          kind: 'status',
          text: mockTag('Connecting...'),
        });
        return {
          exec: { status: 'connecting', sessionId, exitCode: null },
          inputDraft: '',
          terminal,
        };
      });

      const handle = startRun({
        source,
        onEvent: (event) => handleEvent(tabId, sessionId, event),
        onClose: (info) => handleClose(tabId, sessionId, info),
      });
      handles.current.set(tabId, handle);
      return 'started';
    },
    // handleEvent / handleClose are defined below and stable via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [append, closeSocket, getTab, updateTab]
  );

  const handleEvent = useCallback(
    (tabId, sessionId, event) => {
      const current = getTab(tabId);
      if (!current || current.exec.sessionId !== sessionId) return; // stale run

      switch (event.type) {
        case 'open':
          markConnected();
          break;

        case 'status': {
          if (event.state === 'compiling') {
            append(tabId, 'status', mockTag('Compiling...'), sessionId);
            patchExec(tabId, sessionId, { status: 'compiling' });
          } else if (event.state === 'running') {
            append(tabId, 'status', mockTag('Running...'), sessionId);
            patchExec(tabId, sessionId, { status: 'running' });
          }
          break;
        }

        case 'stdout':
        case 'stderr':
          append(tabId, event.type, String(event.data ?? ''), sessionId);
          break;

        case 'input_required':
          // The status bar and the unlocked input box say it; no extra line.
          patchExec(tabId, sessionId, { status: 'waiting_input' });
          break;

        case 'exit': {
          const code = Number.isInteger(event.code) ? event.code : null;
          clearStopTimer(tabId);
          if (current.exec.status === 'stopping') {
            // The user pressed Stop: that is not a failure.
            append(tabId, 'status', 'Stopped', sessionId);
            patchExec(tabId, sessionId, { status: 'stopped', exitCode: code });
            break;
          }
          if (event.phase === 'compile') {
            append(tabId, 'error', 'Compilation failed. See the gcc messages above.', sessionId);
            patchExec(tabId, sessionId, { status: 'failed', exitCode: code, failedPhase: 'compile' });
            break;
          }
          const failed = code !== null && code !== 0;
          append(
            tabId,
            failed ? 'error' : 'status',
            `Process finished (exit code ${code === null ? 'unknown' : code})`,
            sessionId
          );
          patchExec(tabId, sessionId, {
            status: failed ? 'failed' : 'finished',
            exitCode: code,
            failedPhase: null,
          });
          break;
        }

        case 'error':
          append(
            tabId,
            'error',
            String(event.message || 'The backend reported an error.'),
            sessionId
          );
          patchExec(tabId, sessionId, { status: 'failed' });
          // Only a broken connection means the backend is gone; a program
          // hitting its CPU limit, for example, does not.
          if (event.network) markDisconnected();
          break;

        default:
          break;
      }
    },
    [append, clearStopTimer, getTab, markConnected, markDisconnected, patchExec]
  );

  const handleClose = useCallback(
    (tabId, sessionId, info) => {
      const current = getTab(tabId);
      if (!current || current.exec.sessionId !== sessionId) return;
      clearStopTimer(tabId);

      if (!isExecActive(current.exec.status)) return; // already settled

      if (current.exec.status === 'stopping') {
        append(tabId, 'status', 'Stopped', sessionId);
        patchExec(tabId, sessionId, { status: 'stopped' });
        return;
      }

      append(
        tabId,
        'error',
        'The connection to the backend closed before the program finished.',
        sessionId
      );
      patchExec(tabId, sessionId, { status: 'failed' });
      if (info?.unexpected !== false) markDisconnected();
    },
    [append, clearStopTimer, getTab, markDisconnected, patchExec]
  );

  const stop = useCallback(
    (tabId) => {
      const tab = getTab(tabId);
      if (!tab || !isExecActive(tab.exec.status)) return;
      const { sessionId } = tab.exec;

      append(tabId, 'status', 'Stopping...', sessionId);
      patchExec(tabId, sessionId, { status: 'stopping' });

      const handle = handles.current.get(tabId);
      handle?.stop();

      clearStopTimer(tabId);
      stopTimers.current.set(
        tabId,
        setTimeout(() => {
          stopTimers.current.delete(tabId);
          const latest = getTab(tabId);
          if (!latest || latest.exec.sessionId !== sessionId) return;
          if (latest.exec.status !== 'stopping') return;
          closeSocket(tabId);
          append(tabId, 'status', 'Stopped', sessionId);
          patchExec(tabId, sessionId, { status: 'stopped' });
        }, STOP_TIMEOUT_MS)
      );
    },
    [append, clearStopTimer, closeSocket, getTab, patchExec]
  );

  const submitInput = useCallback(
    (tabId, text) => {
      const tab = getTab(tabId);
      if (!tab || tab.exec.status !== 'waiting_input') return;
      const { sessionId } = tab.exec;

      updateTab(tabId, (current) => ({
        inputDraft: '',
        exec: { ...current.exec, status: 'running' },
        terminal: terminalReducer(current.terminal, {
          type: 'append',
          kind: 'stdin',
          text,
          sessionId,
          currentSessionId: current.exec.sessionId,
        }),
      }));

      handles.current.get(tabId)?.sendInput(`${text}\n`);
    },
    [getTab, updateTab]
  );

  return {
    connection,
    generate,
    compileAndRun,
    stop,
    submitInput,
    clearTerminal,
    cleanupTab,
    isMock: MOCK_ENABLED,
  };
}
