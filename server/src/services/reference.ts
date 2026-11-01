import { one, type Tx } from '../db/pool.js';
import { getSetting } from './settings.js';

/** Render a reference mask such as NAM-{PORT}-{YYYY}-{SEQ:6}. */
export function renderMask(mask: string, vars: { port: string; year: number; seq: number }) {
  return mask
    .replace('{PORT}', vars.port)
    .replace('{YYYY}', String(vars.year))
    .replace(/\{SEQ(?::(\d+))?\}/, (_m, w) => String(vars.seq).padStart(Number(w ?? 6), '0'));
}

/**
 * QMC-02 — reference generated atomically on persistence. The sequence row is incremented with a
 * single upsert, so concurrent intake cannot issue the same number. Separate sequences per port
 * mean the reference identifies its origin without a lookup.
 */
export async function nextReference(tx: Tx, port: string, maskKey = 'reference.mask', seqKey = port): Promise<string> {
  const year = new Date().getUTCFullYear();
  const row = await one<{ last_value: number }>(
    tx,
    `INSERT INTO reference_sequences (port_code, year, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (port_code, year) DO UPDATE SET last_value = reference_sequences.last_value + 1
     RETURNING last_value`,
    [seqKey, year],
  );
  const mask = await getSetting<string>(tx, maskKey);
  return renderMask(mask, { port, year, seq: row!.last_value });
}

export const REFERENCE_PATTERN = /\b[A-Z]{2,5}-[A-Z]{2}-\d{4}-\d{3,8}\b/;
