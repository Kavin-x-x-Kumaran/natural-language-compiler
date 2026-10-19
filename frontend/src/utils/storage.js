import { STORAGE_KEY, MAX_TABS } from './constants.js';

/**
 * Persistence helpers for the workspace. Only `id`, `name`, `nlText`, `cCode`
 * and `cEdited` are stored; terminal output, execution state and input drafts
 * are deliberately never persisted.
 *
 * Every read and write is guarded: a missing, malformed or unwritable store
 * must never break the app.
 */

export const DEFAULT_TABS = [
  {
    id: 'tab-adder',
    name: 'adder',
    nlText: 'Read 2 numbers as input\nAdd them\nDisplay the answer',
    cCode: '',
    cEdited: false,
  },
  {
    id: 'tab-even-odd',
    name: 'even odd checker',
    nlText:
      'Read a number as input\nCheck whether it is even or odd\nDisplay the result',
    cCode: '',
    cEdited: false,
  },
];

export function defaultWorkspace() {
  const tabs = DEFAULT_TABS.map((tab) => ({ ...tab }));
  return { tabs, activeId: tabs[0].id };
}

function sanitizeTab(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `tab-${index + 1}`;
  const name =
    typeof raw.name === 'string' && raw.name.trim() ? raw.name : `untitled-${index + 1}`;
  return {
    id,
    name,
    nlText: typeof raw.nlText === 'string' ? raw.nlText : '',
    cCode: typeof raw.cCode === 'string' ? raw.cCode : '',
    cEdited: raw.cEdited === true,
  };
}

/**
 * @returns {{ tabs: Array, activeId: string }} stored workspace, or defaults.
 */
export function loadWorkspace() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultWorkspace();

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs)) return defaultWorkspace();

    const tabs = parsed.tabs
      .map(sanitizeTab)
      .filter(Boolean)
      .slice(0, MAX_TABS);
    if (tabs.length === 0) return defaultWorkspace();

    const activeId = tabs.some((tab) => tab.id === parsed.activeId)
      ? parsed.activeId
      : tabs[0].id;

    return { tabs, activeId };
  } catch {
    return defaultWorkspace();
  }
}

/**
 * @returns {boolean} true when the write succeeded.
 */
export function saveWorkspace({ tabs, activeId }) {
  try {
    const payload = {
      tabs: (tabs || []).map(({ id, name, nlText, cCode, cEdited }) => ({
        id,
        name,
        nlText,
        cCode,
        cEdited,
      })),
      activeId,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
