import { MOD_KEY } from '../hooks/useShortcuts.js';

// Only shortcuts that actually work are listed. Ctrl+T / Ctrl+W are reserved
// by browsers and are not bound at all.
const HINTS = [
  { keys: [MOD_KEY, 'Enter'], label: 'Run' },
  { keys: [MOD_KEY, 'S'], label: 'Save' },
  { keys: ['Alt', 'N'], label: 'New tab' },
  { keys: ['Alt', 'W'], label: 'Close tab' },
  { keys: ['Esc'], label: 'Close dialog' },
];

export default function KeyHints() {
  return (
    <div className="hintbar">
      {HINTS.map((hint) => (
        <span className="hint" key={hint.label}>
          {hint.keys.map((key) => (
            <kbd className="keycap" key={key}>
              {key}
            </kbd>
          ))}
          {hint.label}
        </span>
      ))}
    </div>
  );
}
