import { MOCK_ENABLED, WS_BASE_URL, runSocketUrl } from './endpoints.js';
import { WS_CONNECT_TIMEOUT_MS } from '../utils/constants.js';
import { mockStartRun } from './mock.js';

/**
 * Execution adapter. Owns the socket; it never touches React state and never
 * imports React — everything reaches the UI through `onEvent` / `onClose`.
 *
 * Message contract (implemented by WS /ws/run in backend/main.py):
 *   client -> server  { type:'start', source }
 *                     { type:'stdin', data:'10 20\n' }
 *                     { type:'stop' }
 *   server -> client  { type:'status', state:'compiling'|'running' }
 *                     { type:'stdout'|'stderr', data }
 *                     { type:'input_required' }
 *                     { type:'exit', code, phase:'compile'|'run' }
 *                     { type:'error', message }
 *
 * Errors this file creates itself, for a broken or unreachable connection,
 * carry `network: true`. Errors sent by the backend (e.g. a program hitting
 * its CPU limit) do not, so they never mark the backend as disconnected.
 */

/**
 * @param {object} options
 * @param {string} options.source C source to compile and run
 * @param {(event: object) => void} options.onEvent
 * @param {(info: { code?: number, reason?: string }) => void} [options.onClose]
 * @returns {{ sendInput(text:string): void, stop(): void, close(): void }}
 */
export function startRun({ source, onEvent, onClose }) {
  if (MOCK_ENABLED) return mockStartRun({ source, onEvent, onClose });

  if (!WS_BASE_URL) {
    setTimeout(
      () => onEvent?.({ type: 'error', message: 'Backend URL is not configured.', network: true }),
      0
    );
    return { sendInput() {}, stop() {}, close() {} };
  }

  let socket;
  let closed = false;
  let opened = false;
  let reportedUnreadable = false;

  const finish = (info) => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    onClose?.(info || {});
  };

  const connectTimer = setTimeout(() => {
    if (opened || closed) return;
    onEvent?.({
      type: 'error',
      message: `Could not connect to the backend within ${Math.round(
        WS_CONNECT_TIMEOUT_MS / 1000
      )} seconds. Is it running? Start the app with: npm run dev`,
      network: true,
    });
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
    finish({ reason: 'connect timeout' });
  }, WS_CONNECT_TIMEOUT_MS);

  try {
    socket = new WebSocket(runSocketUrl());
  } catch {
    clearTimeout(connectTimer);
    setTimeout(() => {
      onEvent?.({ type: 'error', message: 'Could not reach the backend. Start the app with: npm run dev', network: true });
      finish({ reason: 'constructor failed' });
    }, 0);
    return { sendInput() {}, stop() {}, close() {} };
  }

  socket.onopen = () => {
    opened = true;
    clearTimeout(connectTimer);
    onEvent?.({ type: 'open' });
    try {
      socket.send(JSON.stringify({ type: 'start', source }));
    } catch {
      onEvent?.({ type: 'error', message: 'Could not send the program to the backend.' });
    }
  };

  socket.onmessage = (message) => {
    let parsed;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      if (!reportedUnreadable) {
        reportedUnreadable = true;
        onEvent?.({
          type: 'error',
          message: 'Received an unreadable message from the server.',
        });
      }
      return;
    }
    if (!parsed || typeof parsed.type !== 'string') {
      if (!reportedUnreadable) {
        reportedUnreadable = true;
        onEvent?.({
          type: 'error',
          message: 'Received an unreadable message from the server.',
        });
      }
      return;
    }
    onEvent?.(parsed);
  };

  socket.onerror = () => {
    if (closed) return;
    onEvent?.({
      type: 'error',
      message: 'Lost the connection to the backend. Is it still running?',
      network: true,
    });
  };

  socket.onclose = (event) => {
    finish({ code: event?.code, reason: event?.reason, unexpected: !opened });
  };

  const send = (message) => {
    if (closed || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* socket is going away; onclose will report it */
    }
  };

  return {
    sendInput(text) {
      send({ type: 'stdin', data: text });
    },
    stop() {
      send({ type: 'stop' });
    },
    close() {
      clearTimeout(connectTimer);
      closed = true;
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}
