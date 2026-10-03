import { Component, type ReactNode } from 'react';

/** A failed lazy import must not erase the whole installed app. */
export class AppErrorBoundary extends Component<{
  children: ReactNode;
  reload?: () => void;
}, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    const missingFile = /dynamically imported module|loading chunk|module script|importing a module/i.test(error.message);
    return <main className="auth" role="alert">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/icon.svg" alt="" />
          <h1>{missingFile ? 'Helm needs a refresh' : 'Helm couldn’t open this screen'}</h1>
          <p>{missingFile
            ? 'An app file could not be loaded. Reload to get the current version.'
            : 'Reload Helm to try again.'}</p>
        </div>
        <button className="primary" onClick={this.props.reload ?? (() => location.reload())}>Reload Helm</button>
        <details className="note"><summary>Error details</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error.message}</pre></details>
      </div>
    </main>;
  }
}
