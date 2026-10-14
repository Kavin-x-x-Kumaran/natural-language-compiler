/**
 * Every backend URL and path lives here.
 *
 * NOTE: the backend does not exist yet. These paths are the FRONTEND'S
 * ANTICIPATED contract (a proposal), not a description of a running server.
 * When the real backend lands, aligning it should only require editing this
 * file, `api.js` and `websocket.js`.
 */

const env = import.meta.env || {};

export const API_BASE_URL = (env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
export const WS_BASE_URL = (env.VITE_WS_BASE_URL || '').replace(/\/+$/, '');
export const MOCK_ENABLED = String(env.VITE_ENABLE_MOCK) === 'true';

// Placeholder paths.
export const GENERATE_PATH = '/compile';
export const WS_RUN_PATH = '/ws/run';

export const generateUrl = () => `${API_BASE_URL}${GENERATE_PATH}`;
export const runSocketUrl = () => `${WS_BASE_URL}${WS_RUN_PATH}`;
