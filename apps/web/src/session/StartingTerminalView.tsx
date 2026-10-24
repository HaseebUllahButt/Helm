import { useEffect, useState } from 'react';
import { useNow } from '../useNow';
import type { Client, Environment } from '../client';
import { BackIcon, Icon } from '../Icon';
import { forgetTerminal, onStartingTerminal, retryTerminal, startingTerminal } from '../startingTerminals';

/**
 * A new terminal before its machine has answered: the terminal screen
 * itself, saying so. If the machine cannot open one, the reason shows here
 * with a way to try again.
 */
export function StartingTerminalView({ client, env, openId, onBack }: {
  client: Client; env: Environment; openId: string; onBack: () => void;
}) {
  const [, redraw] = useState(0);
  const t = startingTerminal(openId);
  useEffect(() => onStartingTerminal((c) => { if (c.id === openId) redraw((n) => n + 1); }), [openId]);
  // A second counter only once the wait is long enough to wonder about.
  const now = useNow(1000, t?.state === 'opening');

  const bar = (
    <div className="bar">
      <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
      <div className="titles" title={env.name}><h1>Terminal</h1></div>
    </div>
  );
  if (!t) return <>{bar}<p className="starting-note">This terminal is open. Find it in the list.</p></>;

  const failed = t.state === 'failed';
  const waited = Math.floor((now - t.since) / 1000);
  return (
    <>
      {bar}
      <div className="terminal-wrap">
        <div className="xterm-host terminal-opening">
          {failed ? (
            <div className="terminal-opening-failed" role="alert">
              <p><b>The terminal did not open.</b> {t.error}</p>
              <div className="starting-actions">
                <button className="primary" onClick={() => retryTerminal(client, openId)}><Icon name="refresh" size={14} />Try again</button>
                <button className="ghost" onClick={() => { forgetTerminal(openId); onBack(); }}>Close</button>
              </div>
            </div>
          ) : (
            <p role="status"><Icon name="think" size={12} className="tspin" />
              Opening a terminal on {env.name}…{waited >= 3 ? ` ${waited}s` : ''}</p>
          )}
        </div>
      </div>
    </>
  );
}
