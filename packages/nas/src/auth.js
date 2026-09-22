import { mintToken, verifyToken } from '@helm/protocol/identity';
import { authenticate, loadNetwork } from '@helm/protocol/network';

/**
 * Who may ask a nas for bytes.
 *
 * Two credentials answer here. The usual one is the bearer token every Helm
 * API already takes - a signed member claim. The other is a *ticket*: the
 * same signed claim with an expiry, minted by the nas itself for one caller
 * and one nas. It exists because the thing that plays media - a <video>
 * element - cannot set an Authorization header, so its credential has to
 * ride in the URL. Putting the durable token in a URL would leave it in
 * browser history, logs and referer headers; the ticket expires instead.
 *
 * Neither credential ever contains the network key: the key signs, it does
 * not travel.
 */

// Long enough to watch a film without re-minting; short enough that a URL
// left in a history is dead by morning.
export const MEDIA_TICKET_TTL_MS = 4 * 60 * 60 * 1000;

export const MEDIA_ROLE = 'media';

/**
 * Mint the URL credential. `env` pins it to this nas and `sub` to whoever
 * called, so a ticket is worthless to anyone else, anywhere else, after its
 * time.
 */
export function mediaTicket(net, { sub, env, ttlMs = MEDIA_TICKET_TTL_MS } = {}) {
  const expiresAt = Date.now() + ttlMs;
  return { ticket: mintToken(net.key, { net: net.id, role: MEDIA_ROLE, sub, env, exp: expiresAt }), expiresAt };
}

/**
 * The authorize plug for mediaHandler and for a hub's /media route.
 *
 * `self` is the machine id the request targets: a ticket minted for a
 * different nas is refused here even though the signature is good. Returns
 * a (req) -> claims|null predicate; null always means "answer 401".
 */
export function mediaAuthorize({ self } = {}) {
  return async (req) => {
    const net = loadNetwork();
    if (!net) return null;

    const url = new URL(req.url, 'http://localhost');
    const t = url.searchParams.get('t');
    if (t) {
      const c = verifyToken(net.key, t);
      if (c && c.role === MEDIA_ROLE && c.net === net.id && c.exp > Date.now()
          && (!self || c.env === self)
          // A ticket for a member that has since been removed must die with it.
          && !net.revoked[c.sub] && (net.machines[c.sub] || net.devices[c.sub])) {
        return c;
      }
      // A bad ticket does not veto a good bearer on the same request.
    }

    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const claims = authenticate(net, m[1]);
    if (!claims || (!net.machines[claims.sub] && !net.devices[claims.sub])) return null;
    return claims;
  };
}
