/**
 * Connection chip. There is no health-check endpoint, so nothing is pinged on
 * load: the chip only turns green after a real successful call.
 */
export default function StatusIndicator({ state }) {
  const label =
    state === 'mock'
      ? 'Mock mode'
      : state === 'connected'
        ? 'Backend connected'
        : 'Backend disconnected';

  return (
    <span className="status-chip" data-state={state} role="status">
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
