/**
 * Header chip showing whether the app can do its job, from the backend's
 * /health check: the backend itself, and the AI model (llama-server) behind it.
 */
const LABELS = {
  mock: 'Mock mode',
  checking: 'Connecting…',
  ready: 'Ready',
  'model-offline': 'AI model not running',
  disconnected: 'Backend not running',
};

const HINTS = {
  ready: 'Backend and AI model are running.',
  'model-offline': 'Compile & Run works. To generate C code, start llama-server (see the README).',
  disconnected: 'Start the app with: npm run dev',
};

export default function StatusIndicator({ state }) {
  return (
    <span className="status-chip" data-state={state} role="status" title={HINTS[state] || ''}>
      <span className="status-dot" aria-hidden="true" />
      {LABELS[state] || 'Backend not running'}
    </span>
  );
}
