import { TerminalSquare } from 'lucide-react';
import StatusIndicator from './StatusIndicator.jsx';

export default function Header({ connection }) {
  return (
    <header className="app-header">
      <h1 className="app-title">
        <TerminalSquare size={18} aria-hidden="true" />
        Natural language compiler
      </h1>
      <StatusIndicator state={connection} />
    </header>
  );
}
