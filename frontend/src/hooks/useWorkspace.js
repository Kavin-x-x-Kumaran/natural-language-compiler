import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUTOSAVE_DEBOUNCE_MS,
  MAX_TABS,
  MAX_TAB_NAME_LENGTH,
} from '../utils/constants.js';
import { defaultWorkspace, loadWorkspace, saveWorkspace } from '../utils/storage.js';

/** Runtime-only fields: never persisted, always rebuilt fresh. */
export function runtimeDefaults() {
  return {
    gen: { status: 'idle', error: null, durationMs: null },
    exec: { status: 'idle', sessionId: null, exitCode: null },
    terminal: [],
    inputDraft: '',
  };
}

function hydrate(tab) {
  return { ...tab, ...runtimeDefaults() };
}

function nextUntitledName(tabs) {
  for (let n = 1; n <= MAX_TABS + 1; n += 1) {
    const candidate = `untitled-${n}`;
    if (!tabs.some((tab) => tab.name === candidate)) return candidate;
  }
  return `untitled-${tabs.length + 1}`;
}

let idCounter = 0;
const freshId = () => `tab-${Date.now().toString(36)}-${(idCounter += 1)}`;

export function emptyTab() {
  return hydrate({
    id: freshId(),
    name: 'untitled-1',
    nlText: '',
    cCode: '',
    cEdited: false,
  });
}

/**
 * Owns the tab list, the active tab and localStorage persistence.
 * Each tab's state is fully independent — nothing is shared across tabs.
 */
export function useWorkspace() {
  const initial = useMemo(() => {
    const base = defaultWorkspace();
    return { tabs: base.tabs.map(hydrate), activeId: base.activeId };
  }, []);

  const [tabs, setTabs] = useState(initial.tabs);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [loaded, setLoaded] = useState(false);
  const [storageWarning, setStorageWarning] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const saveTimer = useRef(null);
  const savedTimer = useRef(null);
  const warnedRef = useRef(false);

  // Load once after mount. Until then the defaults render, so there is no
  // flash of an empty workspace.
  useEffect(() => {
    const stored = loadWorkspace();
    setTabs(stored.tabs.map(hydrate));
    setActiveId(stored.activeId);
    setLoaded(true);
  }, []);

  const persist = useCallback(
    (nextTabs, nextActiveId) => {
      const ok = saveWorkspace({ tabs: nextTabs, activeId: nextActiveId });
      if (!ok && !warnedRef.current) {
        warnedRef.current = true;
        setStorageWarning(
          'Could not save to this browser. Your work stays in memory for this session only.'
        );
      }
      return ok;
    },
    []
  );

  // Debounced autosave on any change to a persisted field.
  const persistedSignature = useMemo(
    () =>
      JSON.stringify({
        activeId,
        tabs: tabs.map(({ id, name, nlText, cCode, cEdited }) => [
          id,
          name,
          nlText,
          cCode,
          cEdited,
        ]),
      }),
    [tabs, activeId]
  );

  useEffect(() => {
    if (!loaded) return undefined;
    saveTimer.current = setTimeout(() => {
      persist(tabs, activeId);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimer.current);
    // persistedSignature captures exactly the fields that are stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedSignature, loaded]);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const saveNow = useCallback(() => {
    clearTimeout(saveTimer.current);
    persist(tabs, activeId);
    setSavedFlash(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedFlash(false), 1500);
  }, [tabs, activeId, persist]);

  const updateTab = useCallback((id, patch) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id
          ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) }
          : tab
      )
    );
  }, []);

  const createTab = useCallback(() => {
    // Built outside the state updater: React may invoke an updater more than
    // once, so it must stay free of side effects.
    if (tabs.length >= MAX_TABS) return null;
    const tab = hydrate({
      id: freshId(),
      name: nextUntitledName(tabs),
      nlText: '',
      cCode: '',
      cEdited: false,
    });
    setTabs((current) =>
      current.length >= MAX_TABS ? current : [...current, tab]
    );
    setActiveId(tab.id);
    return tab;
  }, [tabs]);

  const renameTab = useCallback((id, rawName) => {
    const name = String(rawName).slice(0, MAX_TAB_NAME_LENGTH).trim();
    if (!name) return;
    updateTab(id, { name });
  }, [updateTab]);

  /**
   * Remove a tab. Closing the last one replaces it with a fresh empty tab;
   * closing the active one activates its left neighbour.
   */
  const removeTab = useCallback(
    (id) => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;

      if (tabs.length === 1) {
        const replacement = emptyTab();
        setTabs([replacement]);
        setActiveId(replacement.id);
        return;
      }

      const next = tabs.filter((tab) => tab.id !== id);
      setTabs(next);
      if (activeId === id) {
        setActiveId(next[Math.max(0, index - 1)].id);
      }
    },
    [tabs, activeId]
  );

  const activeTab = tabs.find((tab) => tab.id === activeId) || tabs[0];

  return {
    tabs,
    activeId: activeTab ? activeTab.id : activeId,
    activeTab,
    loaded,
    atTabLimit: tabs.length >= MAX_TABS,
    setActiveId,
    updateTab,
    createTab,
    renameTab,
    removeTab,
    saveNow,
    savedFlash,
    storageWarning,
    dismissStorageWarning: () => setStorageWarning(null),
  };
}
