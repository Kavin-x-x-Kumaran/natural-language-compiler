import { Play, Square } from 'lucide-react';
import LineEditor from './LineEditor.jsx';

export default function SourceCodeEditor({
  value,
  edited,
  onChange,
  onCompileAndRun,
  onStop,
  execActive,
  generating,
}) {
  const hasCode = value.trim().length > 0;
  const lineCount = value === '' ? 0 : value.split('\n').length;

  const disabledReason = !hasCode
    ? 'Press Run first to generate C code'
    : generating
      ? 'Wait for generation to finish'
      : null;

  return (
    <section className="editor-section" aria-label="Generated C source editor">
      <div className="bar editor-header">
        <span className="bar-label">Generated C source</span>
        {hasCode && <span className="badge">{edited ? 'Edited' : 'Generated'}</span>}
        <span className="bar-spacer" />
        {execActive ? (
          <button type="button" className="btn btn-stop" onClick={onStop}>
            <Square size={13} aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onCompileAndRun}
            disabled={!!disabledReason}
            title={disabledReason || 'Compile and run this C source'}
          >
            <Play size={14} aria-hidden="true" />
            Compile &amp; Run
          </button>
        )}
      </div>

      <LineEditor
        value={value}
        onChange={onChange}
        label="C source code"
        placeholder="Generated C code appears here after you press Run."
        insertTabs
      />

      <div className="bar bar-footer">
        <span>
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
        <span>C11</span>
      </div>
    </section>
  );
}
