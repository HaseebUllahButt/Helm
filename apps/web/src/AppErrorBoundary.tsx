import { Component, type ReactNode } from 'react';
import { reloadApp } from './reload';

/** A failed lazy import must not erase the whole installed app. */
export class AppErrorBoundary extends Component<{
  children: ReactNode;
  reload?: () => void;
}, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error) { console.warn('Helm screen failed:', error); }

  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    const missingFile = /dynamically imported module|loading chunk|module script|importing a module/i.test(error.message);
    return <main className="auth" role="alert">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/icon.svg" alt="" />
          <h1>{missingFile ? 'Reload Helm' : 'Helm cannot open this screen.'}</h1>
          <p>{missingFile
            ? 'Helm cannot load an app file. Reload Helm to get the latest version.'
            : 'Reload Helm to try again.'}</p>
        </div>
        <button className="primary" onClick={this.props.reload ?? reloadApp}>Reload Helm</button>
      </div>
    </main>;
  }
}
