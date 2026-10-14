// Matches CSI / OSC / single-character ANSI escape sequences. Backend text is
// always rendered as plain text, so escapes are removed rather than
// interpreted.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Remove ANSI escape sequences from backend output.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  if (typeof text !== 'string') return '';
  return text.replace(ANSI_PATTERN, '');
}
