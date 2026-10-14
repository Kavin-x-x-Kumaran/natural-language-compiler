import { useEffect, useRef } from 'react';

/**
 * Single-line program input. Enabled and focused only while the backend has
 * asked for input; the draft lives on the tab so switching tabs never mixes it.
 */
export default function TerminalInput({ value, onChange, onSubmit, waiting }) {
  const ref = useRef(null);

  useEffect(() => {
    if (waiting) ref.current?.focus();
  }, [waiting]);

  return (
    <div className="terminal-input-row" data-no-shortcuts="true">
      <span className="entry-prompt" aria-hidden="true">
        $
      </span>
      <input
        ref={ref}
        type="text"
        value={value}
        aria-label="Program input"
        disabled={!waiting}
        placeholder={waiting ? '' : 'Program is not asking for input'}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            ref.current?.blur();
            return;
          }
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (!waiting) return; // ignore Enter when nothing is asking
          onSubmit(value);
        }}
      />
    </div>
  );
}
