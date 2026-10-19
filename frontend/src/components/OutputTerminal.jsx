import { useEffect, useRef, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import TerminalInput from './TerminalInput.jsx';
import { isExecActive } from '../hooks/useCompiler.js';

function statusLine(gen, exec) {
  if (exec.status === 'connecting') return ['Connecting...', 'busy'];
  if (exec.status === 'compiling') return ['Compiling...', 'busy'];
  if (exec.status === 'running') return ['Running...', 'busy'];
  if (exec.status === 'waiting_input') return ['Waiting for input...', 'busy'];
  if (exec.status === 'stopping') return ['Stopping...', 'busy'];
  if (exec.status === 'stopped') return ['Stopped', 'neutral'];
  if (exec.status === 'failed')
    return [exec.failedPhase === 'compile' ? 'Compilation failed' : 'Failed', 'bad'];
  if (exec.status === 'finished')
    return [`Process finished (exit code ${exec.exitCode ?? 'unknown'})`, exec.exitCode ? 'bad' : 'good'];
  if (gen.status === 'generating') return ['Generating...', 'busy'];
  if (gen.status === 'error') return ['Code generation failed', 'bad'];
  return ['Ready', 'neutral'];
}

/** Plain text in, plain text out: no HTML is ever produced from backend data. */
function Entry({ entry }) {
  switch (entry.kind) {
    case 'status':
      return <pre className="terminal-entry entry-status">{`• ${entry.text}`}</pre>;
    case 'error':
      return <pre className="terminal-entry entry-error">{`✕ ${entry.text}`}</pre>;
    case 'stderr':
      return <pre className="terminal-entry entry-stderr">{entry.text}</pre>;
    case 'stdin':
      return (
        <pre className="terminal-entry entry-stdin">
          <span className="entry-prompt">$ </span>
          {entry.text}
        </pre>
      );
    case 'source':
      return (
        <details className="entry-source">
          <summary>
            <span className="source-chip">Generated C</span>
          </summary>
          <pre>{entry.text}</pre>
        </details>
      );
    case 'stdout':
    default:
      return <pre className="terminal-entry entry-stdout">{entry.text}</pre>;
  }
}

export default function OutputTerminal({
  entries,
  gen,
  exec,
  inputDraft,
  onInputChange,
  onSubmitInput,
  onClear,
  scrollTargetRef,
}) {
  const bodyRef = useRef(null);
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const execActive = isExecActive(exec.status);
  const [status, tone] = statusLine(gen, exec);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  // Auto-scroll unless the user has scrolled up.
  useEffect(() => {
    if (!pinned) return;
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, pinned, exec.status]);

  const onScroll = () => {
    const node = bodyRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setPinned(atBottom);
  };

  const jumpToLatest = () => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    setPinned(true);
  };

  const copyVisible = async () => {
    const text = entries
      .map((entry) => (entry.kind === 'stdin' ? `$ ${entry.text}` : entry.text))
      .join('');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard denied; nothing else to do
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="pane pane-output" aria-label="Output" ref={scrollTargetRef}>
      <div className="bar terminal-header">
        <span className="bar-label">
          <TerminalSquare size={16} aria-hidden="true" />
          Output
        </span>
        <span className="bar-spacer" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={copyVisible}
          disabled={entries.length === 0}
          title={entries.length === 0 ? 'Nothing to copy' : 'Copy the terminal text'}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="btn btn-outline"
          onClick={onClear}
          disabled={entries.length === 0}
          title={entries.length === 0 ? 'Nothing to clear' : 'Clear this tab’s output'}
        >
          Clear
        </button>
      </div>

      <div
        className="terminal-body"
        role="log"
        aria-live="polite"
        aria-label="Program output"
        ref={bodyRef}
        onScroll={onScroll}
      >
        {entries.length === 0 ? (
          <div className="terminal-empty">
            <pre className="terminal-entry terminal-empty-line">
              <span className="entry-prompt">$ </span>
              <span className="cursor-block" aria-hidden="true" />
            </pre>
            <pre className="terminal-entry entry-status">
              Press Run to generate C code, then Compile &amp; Run to execute it.
            </pre>
          </div>
        ) : (
          entries.map((entry) => <Entry key={entry.id} entry={entry} />)
        )}

        {execActive && (
          <TerminalInput
            value={inputDraft}
            onChange={onInputChange}
            onSubmit={onSubmitInput}
            waiting={exec.status === 'waiting_input'}
          />
        )}

        {!pinned && (
          <button type="button" className="btn btn-outline jump-latest" onClick={jumpToLatest}>
            Jump to latest
          </button>
        )}
      </div>

      <div className="terminal-status" data-tone={tone} aria-live="polite">
        {status}
      </div>
    </section>
  );
}
