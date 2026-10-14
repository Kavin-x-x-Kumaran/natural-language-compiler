/**
 * Turn the natural-language editor content into the request body the backend
 * is expected to accept.
 *
 * Rules (see README -> Assumptions):
 *  - split on \r\n or \n
 *  - `line` is the 1-based number shown in the editor gutter, so blank lines
 *    are skipped but the remaining numbers keep their gutter values (gaps)
 *  - only trailing whitespace is trimmed; leading indentation is preserved
 *  - lines that are empty after trimming are skipped entirely
 *
 * @param {string} text raw editor content
 * @returns {{ nl_code: Array<{ line: number, text: string }> }}
 */
export function buildPayload(text) {
  const source = typeof text === 'string' ? text : '';
  const nl_code = [];

  source.split(/\r?\n/).forEach((raw, index) => {
    const processed = raw.replace(/\s+$/, '');
    if (processed.trim() === '') return;
    nl_code.push({ line: index + 1, text: processed });
  });

  return { nl_code };
}
