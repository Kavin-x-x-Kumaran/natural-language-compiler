import { useCallback, useEffect, useRef, useState } from 'react';
import Header from './components/Header.jsx';
import EditorTabs from './components/EditorTabs.jsx';
import NaturalLanguageEditor from './components/NaturalLanguageEditor.jsx';
import SourceCodeEditor from './components/SourceCodeEditor.jsx';
import OutputTerminal from './components/OutputTerminal.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import KeyHints from './components/KeyHints.jsx';
import { useWorkspace } from './hooks/useWorkspace.js';
import { useCompiler, isExecActive } from './hooks/useCompiler.js';
import { useShortcuts } from './hooks/useShortcuts.js';
import { terminalReducer } from './utils/terminalReducer.js';
import { MOCK_ENABLED } from './services/endpoints.js';

export default function App() {
  const workspace = useWorkspace();
  const {
    tabs,
    activeId,
    activeTab,
    atTabLimit,
    setActiveId,
    updateTab,
    createTab,
    renameTab,
    removeTab,
    saveNow,
    savedFlash,
    storageWarning,
    dismissStorageWarning,
  } = workspace;

  // The compiler reads the live tab list through a ref so its callbacks stay
  // stable while never seeing stale tab state.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const compiler = useCompiler({ updateTab, tabsRef });

  const [dialog, setDialog] = useState(null);
  const outputRef = useRef(null);

  const scrollOutputIntoView = useCallback(() => {
    if (window.matchMedia('(min-width: 768px)').matches) return;
    outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /* ------------------------------------------------------------ generation */

  const runGenerate = useCallback(
    (tabId) => {
      const result = compiler.generate(tabId);
      if (result === 'needs-confirm') {
        setDialog({
          kind: 'overwrite',
          title: 'Replace the edited C code?',
          message: 'Generating again will replace your edited C code.',
          confirmLabel: 'Replace',
          onConfirm: () => {
            setDialog(null);
            compiler.generate(tabId, { force: true });
            scrollOutputIntoView();
          },
        });
        return;
      }
      if (result === 'started') scrollOutputIntoView();
    },
    [compiler, scrollOutputIntoView]
  );

  const runActive = useCallback(() => {
    if (dialog || !activeTab) return;
    runGenerate(activeTab.id);
  }, [activeTab, dialog, runGenerate]);

  const compileAndRunActive = useCallback(() => {
    if (!activeTab) return;
    if (compiler.compileAndRun(activeTab.id) === 'started') scrollOutputIntoView();
  }, [activeTab, compiler, scrollOutputIntoView]);

  /* ----------------------------------------------------------------- tabs */

  const requestClose = useCallback(
    (tabId) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) return;

      const running = isExecActive(tab.exec.status);
      const hasContent = tab.nlText.trim().length > 0 || tab.cCode.trim().length > 0;

      const finish = () => {
        compiler.cleanupTab(tabId);
        removeTab(tabId);
      };

      if (!running && !hasContent) {
        finish();
        return;
      }

      setDialog({
        kind: 'close',
        title: running ? 'Stop and close this tab?' : 'Close this tab?',
        message: running
          ? 'A program is running in this tab. Closing will stop it.'
          : 'Close this tab? Its content will be lost.',
        confirmLabel: running ? 'Stop and close' : 'Close',
        onConfirm: () => {
          setDialog(null);
          finish();
        },
      });
    },
    [compiler, removeTab]
  );

  /* ------------------------------------------------------------- shortcuts */

  useShortcuts({
    enabled: !dialog,
    onRun: runActive,
    onSave: saveNow,
    onNewTab: createTab,
    onCloseTab: () => activeTab && requestClose(activeTab.id),
    onEscape: () => {
      if (dialog) setDialog(null);
    },
  });

  // One non-blocking notice if localStorage is unusable; work continues in memory.
  useEffect(() => {
    if (!storageWarning || !activeTab) return;
    updateTab(activeTab.id, (tab) => ({
      terminal: terminalReducer(tab.terminal, {
        type: 'append',
        kind: 'status',
        text: storageWarning,
      }),
    }));
    dismissStorageWarning();
  }, [storageWarning, activeTab, updateTab, dismissStorageWarning]);

  if (!activeTab) return null;

  const generating = activeTab.gen.status === 'generating';
  const execActive = isExecActive(activeTab.exec.status);

  return (
    <div className="app">
      <Header connection={compiler.connection} />

      {MOCK_ENABLED && (
        <div className="mock-banner" role="status">
          Mock mode: responses are simulated, not produced by the model or a compiler
        </div>
      )}

      <main className="workspace">
        <section className="pane pane-editor" aria-label="Editors">
          <EditorTabs
            tabs={tabs}
            activeId={activeId}
            atTabLimit={atTabLimit}
            onSelect={setActiveId}
            onCreate={createTab}
            onClose={requestClose}
            onRename={renameTab}
          />

          <NaturalLanguageEditor
            key={`nl-${activeTab.id}`}
            value={activeTab.nlText}
            onChange={(nlText) => updateTab(activeTab.id, { nlText })}
            onRun={runActive}
            onClear={() => updateTab(activeTab.id, { nlText: '' })}
            generating={generating}
            savedFlash={savedFlash}
          />

          <div className="pane-divider" />

          <SourceCodeEditor
            key={`c-${activeTab.id}`}
            value={activeTab.cCode}
            edited={activeTab.cEdited}
            onChange={(cCode) => updateTab(activeTab.id, { cCode, cEdited: true })}
            onCompileAndRun={compileAndRunActive}
            onStop={() => compiler.stop(activeTab.id)}
            execActive={execActive}
            generating={generating}
          />
        </section>

        <OutputTerminal
          key={`out-${activeTab.id}`}
          scrollTargetRef={outputRef}
          entries={activeTab.terminal}
          gen={activeTab.gen}
          exec={activeTab.exec}
          inputDraft={activeTab.inputDraft}
          onInputChange={(inputDraft) => updateTab(activeTab.id, { inputDraft })}
          onSubmitInput={(text) => compiler.submitInput(activeTab.id, text)}
          onClear={() => compiler.clearTerminal(activeTab.id)}
        />
      </main>

      <KeyHints />

      <ConfirmDialog
        open={!!dialog}
        title={dialog?.title}
        message={dialog?.message}
        confirmLabel={dialog?.confirmLabel}
        onConfirm={dialog?.onConfirm}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
