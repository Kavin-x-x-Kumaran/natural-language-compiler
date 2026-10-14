import { useEffect, useRef, useState } from 'react';
import { FileCode2, Plus, X } from 'lucide-react';
import { MAX_TAB_NAME_LENGTH } from '../utils/constants.js';

export default function EditorTabs({
  tabs,
  activeId,
  atTabLimit,
  onSelect,
  onCreate,
  onClose,
  onRename,
}) {
  const [renamingId, setRenamingId] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [limitNotice, setLimitNotice] = useState(false);

  const stripRef = useRef(null);
  const noticeTimer = useRef(null);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    const node = stripRef.current?.querySelector('[aria-selected="true"]');
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  const handleCreate = () => {
    if (atTabLimit) {
      setLimitNotice(true);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setLimitNotice(false), 2000);
      return;
    }
    onCreate();
  };

  const startRename = (tab) => {
    setRenamingId(tab.id);
    setDraftName(tab.name);
  };

  const commitRename = () => {
    if (renamingId) onRename(renamingId, draftName);
    setRenamingId(null);
  };

  const onTabKeyDown = (event, index) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    onSelect(next.id);
  };

  return (
    <div className="bar tabbar">
      <div className="tabstrip" role="tablist" aria-label="Open programs" ref={stripRef}>
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className="tab"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              onDoubleClick={() => startRename(tab)}
            >
              <FileCode2 size={14} aria-hidden="true" />
              {renamingId === tab.id ? (
                <input
                  className="tab-rename"
                  data-no-shortcuts="true"
                  value={draftName}
                  maxLength={MAX_TAB_NAME_LENGTH}
                  autoFocus
                  aria-label={`Rename ${tab.name}`}
                  onChange={(event) => setDraftName(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') commitRename();
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <span className="tab-name">{tab.name}</span>
              )}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      {limitNotice && <span className="tab-limit">Tab limit reached</span>}

      <button
        type="button"
        className="btn btn-white btn-icon"
        aria-label="New tab"
        onClick={handleCreate}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
