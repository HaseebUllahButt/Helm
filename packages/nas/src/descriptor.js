import { readlink } from 'node:fs/promises';

let nativePath;

/** Ask the OS about an open descriptor; resolving its original filename is unsafe. */
export async function descriptorPath(fd) {
  if (process.platform === 'linux') return readlink(`/proc/self/fd/${fd}`);
  nativePath ??= loadNativePath();
  return (await nativePath)(fd);
}

async function loadNativePath() {
  // Loaded only on NAS requests on platforms without /proc, never at startup.
  const { default: koffi } = await import('koffi');
  if (process.platform === 'darwin') {
    const libc = koffi.load('/usr/lib/libSystem.B.dylib');
    const fcntl = libc.func('int fcntl(int fd, int command, ...)');
    return (fd) => {
      const buffer = Buffer.alloc(1024); // Darwin MAXPATHLEN
      if (fcntl(fd, 50 /* F_GETPATH */, 'void *', buffer) !== 0) {
        throw new Error('cannot locate the opened media file');
      }
      const end = buffer.indexOf(0);
      if (end <= 0) throw new Error('invalid opened file path');
      return buffer.toString('utf8', 0, end);
    };
  }
  if (process.platform === 'win32') {
    // Use Node's libuv export so the descriptor is translated by the same
    // CRT that opened it, even when Node links its runtime statically.
    const node = koffi.load(process.execPath);
    const osHandle = node.func('void *uv_get_osfhandle(int fd)');
    const kernel = koffi.load('kernel32.dll');
    const finalPath = kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *handle, void *buffer, uint32_t size, uint32_t flags)');
    return (fd) => {
      const buffer = Buffer.alloc(32768 * 2);
      const length = finalPath(osHandle(fd), buffer, buffer.length / 2, 0);
      if (!length || length >= buffer.length / 2) throw new Error('cannot locate the opened media file');
      const path = buffer.toString('utf16le', 0, length * 2);
      // Match Node realpath's DOS/UNC spelling, not the extended namespace.
      if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
      return path.startsWith('\\\\?\\') ? path.slice(4) : path;
    };
  }
  throw new Error('this platform cannot verify opened media paths');
}
