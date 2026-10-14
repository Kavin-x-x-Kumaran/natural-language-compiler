import { useEffect } from 'react';

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Single global keydown listener, removed on unmount.
 *
 * Ctrl+T and Ctrl+W are reserved by browsers and deliberately NOT bound; the
 * Alt variants are used instead (see README).
 *
 * Elements marked `data-no-shortcuts` (the tab-rename field and the terminal
 * input) keep every key to themselves, so normal typing is never swallowed.
 */
export function useShortcuts({ onRun, onSave, onNewTab, onCloseTab, onEscape, enabled = true }) {
  useEffect(() => {
    const handler = (event) => {
      const target = event.target;
      const isGuarded = !!(target && target.closest && target.closest('[data-no-shortcuts]'));

      if (event.key === 'Escape') {
        if (isGuarded) return; // the field itself handles Escape
        onEscape?.(event);
        return;
      }

      if (isGuarded) return; // never swallow keys while typing in a field
      if (!enabled) return;

      const mod = IS_MAC ? event.metaKey : event.ctrlKey;

      if (mod && event.key === 'Enter') {
        event.preventDefault();
        onRun?.();
        return;
      }

      if (mod && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        onSave?.();
        return;
      }

      if (event.altKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        onNewTab?.();
        return;
      }

      if (event.altKey && (event.key === 'w' || event.key === 'W')) {
        event.preventDefault();
        onCloseTab?.();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onRun, onSave, onNewTab, onCloseTab, onEscape, enabled]);
}
