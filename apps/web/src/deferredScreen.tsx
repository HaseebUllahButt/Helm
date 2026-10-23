import { Component, lazy, Suspense, createElement, type ComponentPropsWithRef, type ComponentType, type ReactNode } from 'react';
import { reloadApp } from './reload';

function ScreenFrame({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return <>
    <div className="bar">
      <button className="iconbtn back" onClick={onBack}>Back</button>
      <b>{title}</b>
    </div>
    <div className="scroll"><div className="pad">{children}</div></div>
  </>;
}

class ScreenError extends Component<{
  title: string; onBack: () => void; children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <ScreenFrame title={this.props.title} onBack={this.props.onBack}>
      <p role="alert">Helm cannot open this screen. Reload Helm to try again.</p>
      <button onClick={reloadApp}>Reload Helm</button>
    </ScreenFrame>;
  }
}

/** Keep optional screens out of startup, with recovery inside the current pane. */
export function deferredScreen<T extends ComponentType<any>>(
  title: string, load: () => Promise<{ default: T }>,
) {
  const Screen = lazy(load);
  return function DeferredScreen(props: ComponentPropsWithRef<T> & { onBack: () => void }) {
    return <ScreenError title={title} onBack={props.onBack}>
      <Suspense fallback={<ScreenFrame title={title} onBack={props.onBack}><div className="empty quiet" role="status">Helm is loading.</div></ScreenFrame>}>
        {createElement(Screen, props)}
      </Suspense>
    </ScreenError>;
  };
}
