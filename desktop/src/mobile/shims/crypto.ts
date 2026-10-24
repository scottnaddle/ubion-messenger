/**
 * Minimal `node:crypto` surface for the Capacitor bundle (ubm-auth PKCE).
 * Vite aliases node:crypto → this file. Never used for secrets logging.
 */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Sync SHA-256 (FIPS 180-4) — small pure implementation for PKCE code_challenge. */
function sha256(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const l = data.length;
  const bitLen = l * 8;
  const withOne = l + 1;
  const padLen = (withOne % 64 <= 56 ? 56 : 120) - (withOne % 64);
  const total = withOne + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[l] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 4, bitLen >>> 0, false);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  const w = new Uint32Array(64);
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = ((w[j - 15]! >>> 7) | (w[j - 15]! << 25)) ^ ((w[j - 15]! >>> 18) | (w[j - 15]! << 14)) ^ (w[j - 15]! >>> 3);
      const s1 = ((w[j - 2]! >>> 17) | (w[j - 2]! << 15)) ^ ((w[j - 2]! >>> 19) | (w[j - 2]! << 13)) ^ (w[j - 2]! >>> 10);
      w[j] = (w[j - 16]! + s0 + w[j - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H as unknown as number[];
    for (let j = 0; j < 64; j++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j]! + w[j]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]!, false);
  return out;
}

export function randomBytes(size: number): { toString(encoding: string): string; [Symbol.toStringTag]?: string } {
  const buf = new Uint8Array(size);
  crypto.getRandomValues(buf);
  return {
    toString(encoding: string) {
      if (encoding === "base64url") return b64url(buf);
      if (encoding === "hex") return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
      throw new Error(`encoding ${encoding} not supported in mobile crypto shim`);
    },
  };
}

export function createHash(alg: string) {
  if (alg !== "sha256") throw new Error(`hash ${alg} not supported in mobile crypto shim`);
  let acc = new Uint8Array(0);
  const api = {
    update(input: string | Uint8Array) {
      const next = typeof input === "string" ? new TextEncoder().encode(input) : input;
      const merged = new Uint8Array(acc.length + next.length);
      merged.set(acc);
      merged.set(next, acc.length);
      acc = merged;
      return api;
    },
    digest(encoding?: string) {
      const out = sha256(acc);
      if (encoding === "base64url") return b64url(out);
      if (encoding === "hex") return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
      return out;
    },
  };
  return api;
}
