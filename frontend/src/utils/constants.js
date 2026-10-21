// Frontend-wide limits. All of these are frontend assumptions, documented in
// README.md -> Assumptions. They are not values the backend has agreed to.

export const MAX_LINES = 1000;
export const MAX_TABS = 10;
// Generating C on a laptop CPU can be slow; give the model up to 5 minutes.
export const REQUEST_TIMEOUT_MS = 300000;
export const WS_CONNECT_TIMEOUT_MS = 10000;
export const STOP_TIMEOUT_MS = 5000;
export const MAX_TERMINAL_ENTRIES = 5000;

export const STORAGE_KEY = 'nlc.workspace.v1';
export const AUTOSAVE_DEBOUNCE_MS = 300;
export const MAX_TAB_NAME_LENGTH = 30;
