import { MAX_TERMINAL_ENTRIES } from './constants.js';
import { stripAnsi } from './stripAnsi.js';

// Only streamed program output is merged. Status, stdin echoes, errors and
// source blocks always stay separate entries so ordering stays readable.
const MERGEABLE_KINDS = new Set(['stdout', 'stderr']);

/** @typedef {{ id: number, kind: string, text: string }} TerminalEntry */

export const EMPTY_TERMINAL = [];

function nextId(entries) {
  return entries.length === 0 ? 1 : entries[entries.length - 1].id + 1;
}

function cap(entries) {
  if (entries.length <= MAX_TERMINAL_ENTRIES) return entries;
  return entries.slice(entries.length - MAX_TERMINAL_ENTRIES);
}

/**
 * Pure terminal-history reducer.
 *
 * Actions:
 *  - { type: 'append', kind, text, sessionId?, currentSessionId? }
 *  - { type: 'clear' }
 *
 * Stale-session guard: when both `sessionId` and `currentSessionId` are
 * present and differ, the event belongs to a finished run and is dropped.
 *
 * @param {TerminalEntry[]} entries
 * @param {object} action
 * @returns {TerminalEntry[]}
 */
export function terminalReducer(entries = EMPTY_TERMINAL, action) {
  const list = Array.isArray(entries) ? entries : EMPTY_TERMINAL;

  switch (action && action.type) {
    case 'clear':
      return EMPTY_TERMINAL;

    case 'append': {
      const { kind, sessionId, currentSessionId } = action;
      if (
        sessionId !== undefined &&
        sessionId !== null &&
        currentSessionId !== undefined &&
        currentSessionId !== null &&
        sessionId !== currentSessionId
      ) {
        return list;
      }

      const text = stripAnsi(typeof action.text === 'string' ? action.text : '');
      const last = list[list.length - 1];

      if (last && last.kind === kind && MERGEABLE_KINDS.has(kind)) {
        const merged = list.slice(0, -1);
        merged.push({ ...last, text: last.text + text });
        return cap(merged);
      }

      return cap([...list, { id: nextId(list), kind, text }]);
    }

    default:
      return list;
  }
}

/** Convenience helper: append one entry and return the new array. */
export function appendEntry(entries, kind, text, sessionId, currentSessionId) {
  return terminalReducer(entries, {
    type: 'append',
    kind,
    text,
    sessionId,
    currentSessionId,
  });
}
