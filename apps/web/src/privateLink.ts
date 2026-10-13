/**
 * Post a private link's pass to it, as a top-level form: the pass is in the
 * body, not the address, so it stays out of history and server logs.
 */
export function openPrivateLink(pass: { action: string; grant: string; next: string }, target: Window = window) {
  const doc = target.document;
  const form = doc.createElement('form');
  form.method = 'POST';
  form.action = pass.action;
  for (const [k, v] of [['grant', pass.grant], ['next', pass.next]]) {
    const input = doc.createElement('input');
    input.type = 'hidden'; input.name = k; input.value = v;
    form.appendChild(input);
  }
  doc.body.appendChild(form);
  form.submit();
}
