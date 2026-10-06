import qrcode from 'qrcode-generator';

/**
 * A QR code a phone camera can read straight off the terminal. Two rows of
 * the code per line of text, using half blocks, light on dark or dark on
 * light alike because the quiet zone is drawn as part of the code.
 */
export function terminalQr(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), pad = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -pad; r < n + pad; r += 2) {
    let line = '';
    for (let c = -pad; c < n + pad; c++) {
      const top = dark(r, c), bottom = dark(r + 1, c);
      // Drawn in the light colour: the background stays dark for the modules.
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
