import { API_BASE_URL, MOCK_ENABLED, generateUrl, healthUrl } from './endpoints.js';
import { REQUEST_TIMEOUT_MS } from '../utils/constants.js';
import { mockGenerate } from './mock.js';

/**
 * Error carrying whether the failure was a transport problem, which is what
 * flips the header's connection chip back to "disconnected".
 */
export class GenerationError extends Error {
  constructor(message, { network = false } = {}) {
    super(message);
    this.name = 'GenerationError';
    this.network = network;
  }
}

/**
 * Request C code for a natural-language payload.
 *
 * Backend contract (backend/main.py):
 *   POST {API_BASE_URL}/compile
 *   body [{ "line": 1, "text": "..." }]
 *   2xx  { "code": "<string>" }
 *   4xx/5xx { "error": "<message for the user>" }
 *
 * @param {Array<{line:number,text:string}>} payload
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<string>} the backend's `code` string, used verbatim.
 */
export async function generateCode(payload, { signal } = {}) {
  if (MOCK_ENABLED) return mockGenerate(payload, { signal });

  if (!API_BASE_URL) {
    throw new GenerationError('Backend URL is not configured.');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(generateUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new GenerationError(
        `The AI model took longer than ${Math.round(REQUEST_TIMEOUT_MS / 60000)} minutes. ` +
          'Try again, or use fewer lines.'
      );
    }
    if (error && error.name === 'AbortError') throw error; // caller cancelled
    throw new GenerationError(
      `Could not reach the backend at ${API_BASE_URL}. Is it running? Start the app with: npm run dev`,
      { network: true }
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    // The backend explains failures in plain language; show that as-is.
    let message = `The backend returned an error (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* keep the generic message */
    }
    throw new GenerationError(message);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new GenerationError('Unexpected response format from backend.');
  }

  if (!body || typeof body.code !== 'string') {
    throw new GenerationError('Unexpected response format from backend.');
  }

  return body.code;
}

/**
 * Ask the backend whether it, and the AI model behind it, are up.
 * @returns {Promise<'ready'|'model-offline'|'disconnected'>}
 */
export async function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(healthUrl(), { signal: controller.signal });
    if (!response.ok) return 'disconnected';
    const body = await response.json();
    return body && body.model === 'ok' ? 'ready' : 'model-offline';
  } catch {
    return 'disconnected';
  } finally {
    clearTimeout(timer);
  }
}
