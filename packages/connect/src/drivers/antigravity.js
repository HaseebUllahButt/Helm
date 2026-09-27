import { rm } from 'node:fs/promises';
import { AcpDriver } from './acp.js';
import { modeFor } from '../modes.js';
import {
  ANTIGRAVITY_AUTH_PREFIX,
  antigravityAuthMethod,
  antigravityEnv,
  forwardAntigravityRedirect,
  prepareAntigravityProfile,
  validateAntigravityRedirect,
} from '../antigravity.js';
import { expand } from '../paths.js';

/**
 * Google's official Antigravity ACP agent (agy_acp_server.par), driven headless.
 *
 * Plain ACP once a session is up - session/new, session/prompt,
 * session/request_permission - with four quirks the spec seams exist for:
 *
 *   - It is a managed binary helm installs itself (`helm antigravity
 *     install`), not a CLI on PATH, so there is no version to probe and
 *     `min` stays null - asking a PyInstaller bundle for `--version` costs
 *     it a ~1GB unpack.
 *   - It refuses session/new with an auth error until `authenticate` runs.
 *     oauth-personal prints its Google URL as a plain stdout line - caught
 *     in onStdoutLine - and the user's browser finishes on the agent's own
 *     127.0.0.1 listener. gemini-api-key needs no browser at all.
 *   - On a phone the OAuth redirect page cannot load, so the owner pastes
 *     the failed 127.0.0.1 address back into chat; localCommand forwards
 *     it to the listener instead of sending it to the model. It answers as
 *     a local turn, which also means it runs beside the blocked start
 *     rather than queueing behind it.
 *   - Resuming a conversation is `session/resume`, not session/load.
 *
 * Env: per-profile GEMINI_HOME (the profile env already carries it),
 * ANTIGRAVITY_HARNESS_PATH next to the exe, a helm-owned TMPDIR for the
 * bundle's ~1GB per-launch unpack, and ambient Google credentials scrubbed
 * so the configured auth method is the only one the agent can see.
 *
 * Written against agy_acp_server_1.1.1; the wire behaviour mirrors T3
 * Code's adapter for the same binary.
 */
export class AntigravityDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'antigravity',
      label: 'Antigravity',
      min: null, // a PyInstaller bundle answers --version by unpacking ~1GB
      args: () => (process.platform === 'linux' ? ['--uid='] : []),
      acpMode: (m) => modeFor('antigravity', m)?.acp ?? null,
      effortId: null,
      resumeVerb: 'session/resume',
      authMethod: (d) => antigravityAuthMethod(d.env ?? {}),

      prepare: async (d) => {
        // Each launch gets its own unpack dir; it is removed by onExit.
        // There is deliberately no sweep of the shared parent - a second
        // live session's TMPDIR sits there too, and deleting it from under
        // a running PyInstaller bundle kills that agent.
        d._agy = await prepareAntigravityProfile(d.env ?? {});
      },

      spawnEnv: (d, merged) => antigravityEnv(merged, {
        exe: d.cmd,
        geminiHome: d._agy?.geminiHome ?? expand(d.env?.GEMINI_HOME || '~/.helm/antigravity'),
        tmpDir: d._agy?.tmpDir ?? expand('~/.helm/tools/antigravity-acp/tmp'),
      }),

      onStdoutLine: (d, line) => {
        if (!line.startsWith(ANTIGRAVITY_AUTH_PREFIX)) return false;
        const url = line.slice(ANTIGRAVITY_AUTH_PREFIX.length).trim();
        const pending = parseAuthUrl(url);
        if (!pending) {
          d.push('error', { message: 'Antigravity printed a sign-in link helm could not read.', kind: 'auth' });
          return true;
        }
        d._agyAuth = pending;
        d.push('error', {
          kind: 'auth',
          message:
            `Antigravity needs a Google sign-in.\n\n` +
            `Open this link in a browser **on this machine** and it finishes on its own:\n${pending.authorizationUrl}\n\n` +
            `On a phone the last page will not load - copy its address (it starts http://127.0.0.1) and send it back here.`,
        });
        return true;
      },

      // The pasted OAuth redirect is not a prompt. It runs as a local turn
      // so it works while start() is still blocked inside authenticate -
      // and authPending means it only swallows URLs while a sign-in really
      // is waiting for one.
      localCommand: (d, text) => {
        const raw = String(text ?? '').trim();
        if (!/^https?:\/\/127\.0\.0\.1:\d+\//.test(raw)) return null;
        if (!d._agyAuth || !d.authPending) return null;
        return async () => {
          const checked = validateAntigravityRedirect(d._agyAuth, raw);
          if (checked.error) return `*${checked.error}*`;
          try {
            await forwardAntigravityRedirect(checked.callback);
          } catch (err) {
            return `*Could not deliver the sign-in response: ${err.message}*`;
          }
          d._agyAuth = null;
          return 'Sign-in response delivered - Antigravity is finishing sign-in.';
        };
      },

      onExit: (d) => {
        if (d._agy?.tmpDir) rm(d._agy.tmpDir, { recursive: true, force: true }).catch(() => {});
      },
    }, opts);
  }
}

/**
 * The Google OAuth URL the agent prints, checked to the shape T3's adapter
 * accepts: accounts.google.com/o/oauth2/v2/auth with a 127.0.0.1 redirect.
 * Returns { authorizationUrl, redirectUri, state } or null.
 */
function parseAuthUrl(authorizationUrl) {
  try {
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get('state');
    const redirectUri = url.searchParams.get('redirect_uri');
    if (
      url.origin !== 'https://accounts.google.com' ||
      url.pathname !== '/o/oauth2/v2/auth' ||
      url.username || url.password || url.hash ||
      url.searchParams.get('response_type') !== 'code' ||
      !state || /\s/.test(state) || state.length > 512 ||
      !redirectUri || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/$/.test(redirectUri)
    ) return null;
    return { authorizationUrl, redirectUri, state };
  } catch {
    return null;
  }
}
