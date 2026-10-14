import { API_BASE_URL, MOCK_ENABLED, generateUrl } from './endpoints.js';
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
 * ANTICIPATED contract (frontend proposal, see README):
 *   POST {VITE_API_BASE_URL}/compile
 *   body { "nl_code": [{ "line": 1, "text": "..." }] }
 *   2xx  { "output": "<string>" }
 *
 * @param {{ nl_code: Array<{line:number,text:string}> }} payload
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<string>} the backend's `output` string, used verbatim.
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
        `The request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`,
        { network: true }
      );
    }
    if (error && error.name === 'AbortError') throw error; // caller cancelled
    throw new GenerationError('Could not reach the backend.', { network: true });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    let detail = response.statusText || '';
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') detail = body.error;
    } catch {
      /* keep statusText */
    }
    throw new GenerationError(
      `HTTP ${response.status}${detail ? ` — ${detail}` : ''}`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new GenerationError('Unexpected response format from backend.');
  }

  if (!body || typeof body.output !== 'string') {
    throw new GenerationError('Unexpected response format from backend.');
  }

  return body.output;
}
