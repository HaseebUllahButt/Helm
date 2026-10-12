import { fileURLToPath } from 'node:url';

export const PI_SETTINGS_EXTENSION = fileURLToPath(new URL('../extensions/helm-settings.ts', import.meta.url));
export function piChatArgs(args) {
  return args.some(arg => arg === PI_SETTINGS_EXTENSION || arg === `--extension=${PI_SETTINGS_EXTENSION}`) ? args : [...args, '--extension', PI_SETTINGS_EXTENSION];
}

export { BASH_GUARD_MODES } from './modes.js';
