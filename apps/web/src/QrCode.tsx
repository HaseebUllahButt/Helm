import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * A link a phone camera can open. Dark on a white plate whatever the theme:
 * cameras read that reliably, and the quiet zone around it is part of the code.
 */
export function QrCode({ value, label, size = 196 }: { value: string; label: string; size?: number }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { n: n + 8, path };
  }, [value]);
  return (
    <svg className="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${cells.n} ${cells.n}`} shapeRendering="crispEdges">
      <rect width={cells.n} height={cells.n} fill="#fff" />
      <path d={cells.path} fill="#000" />
    </svg>
  );
}
