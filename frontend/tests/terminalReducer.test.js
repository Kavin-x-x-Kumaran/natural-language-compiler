import { describe, it, expect } from 'vitest';
import { terminalReducer, appendEntry } from '../src/utils/terminalReducer.js';
import { MAX_TERMINAL_ENTRIES } from '../src/utils/constants.js';

const append = (kind, text, extra = {}) => ({
  type: 'append',
  kind,
  text,
  ...extra,
});

describe('terminalReducer', () => {
  it('merges consecutive chunks of the same kind into one entry', () => {
    let state = terminalReducer([], append('stdout', 'Hello '));
    state = terminalReducer(state, append('stdout', 'world'));
    expect(state).toHaveLength(1);
    expect(state[0].text).toBe('Hello world');
  });

  it('does not merge across different kinds and preserves order', () => {
    let state = terminalReducer([], append('stdout', 'a'));
    state = terminalReducer(state, append('stderr', 'b'));
    state = terminalReducer(state, append('stdout', 'c'));
    expect(state.map((entry) => [entry.kind, entry.text])).toEqual([
      ['stdout', 'a'],
      ['stderr', 'b'],
      ['stdout', 'c'],
    ]);
  });

  it('keeps status, stdin and error entries separate even when repeated', () => {
    let state = terminalReducer([], append('status', 'Compiling...'));
    state = terminalReducer(state, append('status', 'Running...'));
    expect(state).toHaveLength(2);
  });

  it('strips ANSI escape sequences from appended text', () => {
    const state = terminalReducer([], append('stdout', '\u001B[31mred\u001B[0m'));
    expect(state[0].text).toBe('red');
  });

  it('drops the oldest entries beyond the cap', () => {
    let state = [];
    for (let i = 0; i < MAX_TERMINAL_ENTRIES + 25; i += 1) {
      state = terminalReducer(state, append('status', `line ${i}`));
    }
    expect(state).toHaveLength(MAX_TERMINAL_ENTRIES);
    expect(state[0].text).toBe('line 25');
    expect(state[state.length - 1].text).toBe(
      `line ${MAX_TERMINAL_ENTRIES + 24}`
    );
  });

  it('ignores events from a stale sessionId', () => {
    const state = terminalReducer([], append('stdout', 'current', {
      sessionId: 2,
      currentSessionId: 2,
    }));
    const unchanged = terminalReducer(
      state,
      append('stdout', 'from an old run', { sessionId: 1, currentSessionId: 2 })
    );
    expect(unchanged).toBe(state);
    expect(unchanged.map((entry) => entry.text)).toEqual(['current']);
  });

  it('clears the history', () => {
    const state = terminalReducer([], append('stdout', 'x'));
    expect(terminalReducer(state, { type: 'clear' })).toEqual([]);
  });

  it('returns the same array for unknown actions', () => {
    const state = terminalReducer([], append('stdout', 'x'));
    expect(terminalReducer(state, { type: 'nope' })).toBe(state);
  });

  it('appendEntry is a thin wrapper honouring the stale guard', () => {
    const state = appendEntry([], 'stdout', 'a', 1, 1);
    expect(appendEntry(state, 'stdout', 'b', 0, 1)).toBe(state);
  });
});
