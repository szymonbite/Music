// The parts of node:crypto that server modules use, built on the browser's
// Web Crypto, for the Android app build (see vite.config.ts). Hashing is only
// needed for login sessions and the web OAuth flow, which the app doesn't use.

function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/** A random integer in [min, max). */
function randomInt(min: number, max: number): number {
  const range = max - min;
  const [value] = globalThis.crypto.getRandomValues(new Uint32Array(1));
  return min + (value! % range);
}

function randomBytes(size: number): { toString(encoding: 'hex' | 'base64url'): string } {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(size));
  return {
    toString(encoding) {
      if (encoding === 'hex') return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
  };
}

function createHash(): never {
  throw new Error('Hashing isn’t available in the Earworm app');
}

export default { randomUUID, randomInt, randomBytes, createHash };
