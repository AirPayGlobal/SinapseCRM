import crypto from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for optional MFA in the external customer realm. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secret: string, at = Date.now(), step = 30) {
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

export function verifyTotp(secret: string, code: string, window = 1) {
  const c = (code ?? '').replace(/\s/g, '');
  for (let w = -window; w <= window; w++) {
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, Date.now() + w * 30_000)), Buffer.from(c.padStart(6, '0').slice(0, 6)))) return true;
  }
  return false;
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
