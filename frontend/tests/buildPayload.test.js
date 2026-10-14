import { describe, it, expect } from 'vitest';
import { buildPayload } from '../src/utils/buildPayload.js';

describe('buildPayload', () => {
  it('produces the exact documented shape for the adder example', () => {
    const payload = buildPayload(
      'Read 2 numbers as input\nAdd them\nDisplay the answer'
    );
    expect(JSON.stringify(payload)).toBe(
      '[{"line":1,"text":"Read 2 numbers as input"},{"line":2,"text":"Add them"},{"line":3,"text":"Display the answer"}]'
    );
  });

  it('skips blank lines but keeps gutter line numbering', () => {
    const payload = buildPayload('first\n\n\nfourth\n   \nsixth');
    expect(payload).toEqual([
      { line: 1, text: 'first' },
      { line: 4, text: 'fourth' },
      { line: 6, text: 'sixth' },
    ]);
  });

  it('trims trailing whitespace and keeps leading indentation', () => {
    const payload = buildPayload('  indented line   \nplain\t');
    expect(payload).toEqual([
      { line: 1, text: '  indented line' },
      { line: 2, text: 'plain' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const payload = buildPayload('one\r\ntwo');
    expect(payload).toEqual([
      { line: 1, text: 'one' },
      { line: 2, text: 'two' },
    ]);
  });

  it('yields no lines for empty or whitespace-only input', () => {
    expect(buildPayload('')).toEqual([]);
    expect(buildPayload('   \n\t\n  \n')).toEqual([]);
    expect(buildPayload(undefined)).toEqual([]);
  });
});
