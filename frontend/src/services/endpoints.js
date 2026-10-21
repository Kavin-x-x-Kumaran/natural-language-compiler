/**
 * Every backend URL and path lives here (implemented in backend/main.py).
 *
 * With no frontend/.env, the app talks to the backend's default address,
 * http://127.0.0.1:8000. Set VITE_API_BASE_URL / VITE_WS_BASE_URL only if you
 * run the backend somewhere else.
 */

const env = import.meta.env || {};

export const API_BASE_URL = (env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
export const WS_BASE_URL = (env.VITE_WS_BASE_URL || 'ws://127.0.0.1:8000').replace(/\/+$/, '');
export const MOCK_ENABLED = String(env.VITE_ENABLE_MOCK) === 'true';

export const GENERATE_PATH = '/compile';
export const WS_RUN_PATH = '/ws/run';
export const HEALTH_PATH = '/health';

export const generateUrl = () => `${API_BASE_URL}${GENERATE_PATH}`;
export const runSocketUrl = () => `${WS_BASE_URL}${WS_RUN_PATH}`;
export const healthUrl = () => `${API_BASE_URL}${HEALTH_PATH}`;
