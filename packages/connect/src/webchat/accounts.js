// Web chat accounts: a signed-in site in a browser profile, saved as a Helm
// account (profiles.json) with engine 'webchat'. The settings ride in the
// account's environment, so the driver, the model list and the account key
// (settings.js accountKey) read them where they read every other account's.
import { loadProfiles, saveProfiles } from '../profiles.js';
import { SITES, siteFor } from './sites/index.js';
import { ENGINE, webchatConfig } from './config.js';

export { ENGINE, webchatConfig };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** The account record for `helm webchat add`. */
export function webchatProfile(id, { site, profile, model = null, machine = null, temporary = false }) {
  if (!NAME.test(String(id ?? ''))) throw new Error('Name the account with letters, digits, dot, dash or underscore (41 at most).');
  const s = siteFor(site);
  if (!profile || typeof profile !== 'string') throw new Error('Name the browser profile that is signed in to the site: --profile <name>. helm browser profiles lists them.');
  return {
    id,
    label: `${s.label} web · ${id}`,
    engine: ENGINE,
    cmd: 'helm',
    args: [],
    env: {
      // First: this value names the account (settings.js accountKey).
      HELM_WEBCHAT_HOME: `~/.helm/webchat/${id}`,
      HELM_WEBCHAT_SITE: s.id,
      HELM_WEBCHAT_PROFILE: profile,
      ...(model ? { HELM_WEBCHAT_MODEL: model } : {}),
      ...(machine ? { HELM_WEBCHAT_MACHINE: machine } : {}),
      ...(temporary ? { HELM_WEBCHAT_TEMPORARY: '1' } : {}),
    },
    source: 'custom',
  };
}

/** Add or change a web chat account. An account of another kind keeps its name. */
export function addWebchat(id, options, { load = loadProfiles, save = saveProfiles } = {}) {
  const record = webchatProfile(id, options);
  const profiles = load()?.profiles ?? [];
  const at = profiles.findIndex((p) => p.id === id);
  if (at >= 0 && profiles[at].engine !== ENGINE) throw new Error(`The account "${id}" already exists and is not a web chat. Choose another name.`);
  const replaced = at >= 0;
  if (replaced) profiles[at] = record; else profiles.push(record);
  save(profiles);
  return { account: describe(record), replaced };
}

export function listWebchat({ load = loadProfiles } = {}) {
  return (load()?.profiles ?? []).filter((p) => p.engine === ENGINE).map(describe);
}

export function removeWebchat(id, { load = loadProfiles, save = saveProfiles } = {}) {
  const profiles = load()?.profiles ?? [];
  const hit = profiles.find((p) => p.id === id);
  if (!hit) throw new Error(`There is no account "${id}". helm webchat list shows the web chat accounts.`);
  if (hit.engine !== ENGINE) throw new Error(`"${id}" is not a web chat account. helm webchat remove removes only web chat accounts.`);
  save(profiles.filter((p) => p.id !== id));
  return describe(hit);
}

function describe(p) {
  const c = webchatConfig(p.env);
  return { id: p.id, site: c.site, siteLabel: SITES[c.site]?.label ?? c.site, profile: c.profile, model: c.model, machine: c.machine, temporary: c.temporary };
}
