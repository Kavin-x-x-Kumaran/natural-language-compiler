import { Play } from 'lucide-react';
import LineEditor from './LineEditor.jsx';
import { buildPayload } from '../utils/buildPayload.js';

export default function NaturalLanguageEditor({
  value,
  onChange,
  onRun,
  onClear,
  generating,
  savedFlash,
}) {
  const lineCount = buildPayload(value).nl_code.length;

  return (
    <section className="editor-section" aria-label="Natural language editor">
      <div className="bar editor-header">
        <span className="bar-label">Natural language</span>
        <span className="bar-spacer" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={onClear}
          disabled={value.length === 0}
          title={value.length === 0 ? 'Nothing to clear' : 'Clear this tab’s natural language'}
        >
          Clear
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onRun}
          disabled={generating}
          title={generating ? 'Generation already in progress' : 'Generate C code'}
        >
          {generating ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
          Run
        </button>
      </div>

      <LineEditor
        value={value}
        onChange={onChange}
        label="Natural language code"
        placeholder="Describe one step per line…"
      />

      <div className="bar bar-footer">
        <span>
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          {savedFlash && <span className="saved-flag"> · Saved</span>}
        </span>
        <span>NL → C11</span>
      </div>
    </section>
  );
}
