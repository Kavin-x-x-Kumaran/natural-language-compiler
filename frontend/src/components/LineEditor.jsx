import { useEffect, useId, useLayoutEffect, useRef } from 'react';

/**
 * Shared textarea + line-number gutter.
 *
 * The gutter and the textarea live in ONE scroll container: the textarea is
 * resized to its full content height, so the container's vertical scroll moves
 * both together and the numbers can never drift out of sync.
 */
export default function LineEditor({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
  insertTabs = false,
  onKeyDown,
  textareaRef,
}) {
  const innerRef = useRef(null);
  const ref = textareaRef || innerRef;
  const id = useId();

  const lineCount = Math.max(1, value.split('\n').length);

  // Grow the textarea to its content so the shared container does the scrolling.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [value, ref]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => {
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight}px`;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  const handleKeyDown = (event) => {
    if (insertTabs && event.key === 'Tab') {
      event.preventDefault();
      const node = event.target;
      const { selectionStart, selectionEnd } = node;
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
      onChange(next);
      requestAnimationFrame(() => {
        node.selectionStart = selectionStart + 2;
        node.selectionEnd = selectionStart + 2;
      });
      return;
    }
    onKeyDown?.(event);
  };

  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  return (
    <div className="line-editor">
      <div className="line-editor-scroll">
        <div className="line-gutter" aria-hidden="true">
          {gutter}
        </div>
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          readOnly={readOnly}
          spellCheck={false}
          wrap="off"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          rows={1}
        />
      </div>
    </div>
  );
}
