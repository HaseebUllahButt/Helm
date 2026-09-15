const MAX_DIMENSION = 2048;
const MIN_DIMENSION = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const QUALITIES = [0.82, 0.72, 0.62, 0.52, 0.42];
const MIME = 'image/jpeg';

/** How many images may ride on one message. */
export const MAX_ATTACHMENTS = 4;

/**
 * What the file picker offers. Deliberately `image/*` rather than a list of
 * types: a phone's camera roll is full of HEIC, and naming four MIME types
 * here would grey those photos out in the picker before the browser ever
 * got the chance to say whether it can decode one.
 */
export const IMAGE_ACCEPT = 'image/*';

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;

/**
 * Is this worth handing to the decoder?
 *
 * The old test was a set of four MIME types, which rejected two things it
 * should not have. A file picked on Android or dropped from some apps
 * arrives with `type: ''`, and an iPhone photo arrives as `image/heic` -
 * both were told to "use a JPG, PNG, WebP, or GIF image" while being
 * exactly that. The browser is the only honest authority on what it can
 * decode, so anything image-shaped is offered to it and a real failure is
 * reported from there.
 */
export function looksLikeImage(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  return !type && IMAGE_EXTENSIONS.test(file.name || '');
}

export interface PreparedImage {
  name: string;
  mime: typeof MIME;
  data: string;
  url: string;
}

/** What a decoded image is, whichever route decoded it. */
type Decoded = { source: CanvasImageSource; width: number; height: number };

function cannotDecode(file: File): Error {
  // HEIC is the one that actually bites: it is what an iPhone shoots by
  // default, and only Safari decodes it. Saying so beats "could not decode
  // it", which reads like the file is broken when it is not.
  const heic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');
  return new Error(heic
    ? 'this browser cannot read HEIC photos - share it as JPEG'
    : 'the browser could not decode it');
}

/**
 * Decode a picked file.
 *
 * `createImageBitmap` first, and not only because it is tidier than juggling
 * an object URL's lifetime: the app is served under a CSP, and an `img-src`
 * without `blob:` makes `new Image()` on an object URL fail for *every*
 * photo, with an error that blames the file. (It did. That is fixed in the
 * relay's headers too, but a decoder that never needs the permission cannot
 * be broken by it again.) It also applies EXIF orientation, so a picture
 * taken in portrait does not arrive on its side.
 *
 * The `<img>` route stays as the fallback for anything without it.
 */
async function loadImage(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (bitmap.width && bitmap.height) {
        return { source: bitmap, width: bitmap.width, height: bitmap.height };
      }
    } catch { /* fall through and try the old way */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('the image has no usable dimensions'));
        return;
      }
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(cannotDecode(file));
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
  if (!looksLikeImage(file)) throw new Error('that is not an image file');
  if (!file.size) throw new Error('the file is empty');

  const image = await loadImage(file);
  const sourceWidth = image.width;
  const sourceHeight = image.height;
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
    // An animated GIF gives up its first frame here, which is what the
    // model would have looked at anyway.
    context.drawImage(image.source, 0, 0, width, height);

    for (const quality of QUALITIES) {
      const candidate = await encode(canvas, quality);
      if (candidate.size <= MAX_BYTES) {
        blob = candidate;
        break;
      }
    }
    maxDimension = Math.floor(maxDimension * 0.8);
  }

  // An ImageBitmap holds decoded pixels until it is closed, which on a phone
  // with four photos queued is real memory.
  if (typeof ImageBitmap !== 'undefined' && image.source instanceof ImageBitmap) {
    image.source.close();
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
