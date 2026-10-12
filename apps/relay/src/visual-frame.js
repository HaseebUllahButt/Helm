import { VISUAL_POLICY, visualHostDocument } from '@helm/protocol/visual';

// No snapshot or credential is served here. The parent reads the saved visual
// through authenticated RPC, then sends it to this opaque frame. The header
// sandbox also protects this document when opened outside Helm's iframe.
export const VISUAL_FRAME_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': `${VISUAL_POLICY}; sandbox allow-scripts; frame-ancestors 'self'`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const body = visualHostDocument();
export function serveVisualFrame(req, res) {
  res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 200 : 405, VISUAL_FRAME_HEADERS);
  res.end(req.method === 'GET' ? body : undefined);
}
