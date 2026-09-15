const MAX_DIMENSION = 2048;
const MIN_DIMENSION = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const QUALITIES = [0.82, 0.72, 0.62, 0.52, 0.42];
const MIME = 'image/jpeg';

/** Formats that the browser can be asked to rasterise before compression. */
export const COMPRESSIBLE_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

export interface PreparedImage {
  name: string;
  mime: typeof MIME;
  data: string;
  url: string;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('the image has no usable dimensions'));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the browser could not decode it'));
    };
    image.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('the browser could not encode it'));
        return;
      }
      if (blob.type !== MIME) {
        reject(new Error('the browser does not support JPEG encoding'));
        return;
      }
      resolve(blob);
    }, MIME, quality);
  });
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('the compressed image could not be read'));
    reader.readAsDataURL(blob);
  });
}

function compressedName(name: string): string {
  const stem = name.replace(/\.[^.]*$/, '') || 'image';
  return `${stem}.jpg`;
}

/**
 * Decode and re-encode an image locally. There is deliberately no original
 * file fallback: a caller either gets a compressed JPEG or an error.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!COMPRESSIBLE_IMAGE_TYPES.has(file.type.toLowerCase())) {
    throw new Error('use a JPG, PNG, WebP, or GIF image');
  }

  const image = await loadImage(file);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const longest = Math.max(sourceWidth, sourceHeight);
  let maxDimension = Math.min(MAX_DIMENSION, Math.max(longest, MIN_DIMENSION));

  let blob: Blob | undefined;
  // Reducing dimensions as needed makes the size bound reliable even for
  // very detailed camera photos. Every candidate is newly encoded as JPEG.
  while (!blob && maxDimension >= MIN_DIMENSION) {
    const scale = Math.min(1, maxDimension / longest);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('the browser could not prepare a canvas');

    // JPEG has no alpha channel. A white background keeps transparent PNGs
    // readable instead of turning their transparent areas black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    for (const quality of QUALITIES) {
      const candidate = await encode(canvas, quality);
      if (candidate.size <= MAX_BYTES) {
        blob = candidate;
        break;
      }
    }
    maxDimension = Math.floor(maxDimension * 0.8);
  }

  if (!blob) throw new Error('the image could not be compressed below 4 MB');

  const url = await dataUrl(blob);
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('the compressed image had an invalid data URL');
  return {
    name: compressedName(file.name),
    mime: MIME,
    data: url.slice(comma + 1),
    url,
  };
}
