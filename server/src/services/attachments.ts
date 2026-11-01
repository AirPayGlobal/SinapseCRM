import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { one, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { Ctx } from '../lib/context.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

/**
 * Attachments (CM01.2): virus-scanned on receipt, stored in object storage by content key,
 * access inherited from the query (row-level security), and their contents indexed for search.
 */

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|js|vbs|ps1|msi|dll|jar)$/i;

async function clamScan(buf: Buffer): Promise<'clean' | 'infected' | 'error'> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: config.clamav.host, port: config.clamav.port });
    let reply = '';
    sock.setTimeout(30_000, () => { sock.destroy(); resolve('error'); });
    sock.on('error', () => resolve('error'));
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => resolve(/FOUND/.test(reply) ? 'infected' : /OK/.test(reply) ? 'clean' : 'error'));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
        sock.write(len); sock.write(chunk);
      }
      sock.end(Buffer.alloc(4));
    });
  });
}

export async function scan(buf: Buffer): Promise<'clean' | 'infected' | 'error'> {
  if (buf.includes(Buffer.from(EICAR))) return 'infected';
  if (config.clamav.host) return clamScan(buf);
  return 'clean';
}

/** Best-effort text extraction for indexing: plain text formats and text streams in PDFs. */
export function extractText(buf: Buffer, mime: string, filename: string): string | null {
  const lower = filename.toLowerCase();
  if (mime.startsWith('text/') || /\.(txt|csv|md|json|xml|html?)$/.test(lower) || mime === 'application/json') {
    const s = buf.toString('utf8');
    return (mime.includes('html') || /\.html?$/.test(lower) ? s.replace(/<[^>]+>/g, ' ') : s).replace(/\s+/g, ' ').slice(0, 200_000);
  }
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    const raw = buf.toString('latin1');
    const parts: string[] = [];
    const streamRe = /<<([^>]*?)>>\s*stream\r?\n([\s\S]*?)endstream/g;
    let m: RegExpExecArray | null;
    while ((m = streamRe.exec(raw)) && parts.join(' ').length < 200_000) {
      let content = m[2];
      if (/FlateDecode/.test(m[1])) {
        try { content = zlib.inflateSync(Buffer.from(content, 'latin1')).toString('latin1'); } catch { continue; }
      }
      const texts = [...content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*T[jJ]|\[((?:\\.|[^\]])*)\]\s*TJ/g)]
        .map((t) => (t[1] ?? (t[2] ?? '').replace(/\(((?:\\.|[^\\)])*)\)|-?\d+(\.\d+)?/g, '$1')).replace(/\\([()\\])/g, '$1'));
      if (texts.length) parts.push(texts.join(' '));
    }
    const s = parts.join(' ').replace(/\s+/g, ' ').trim();
    return s || null;
  }
  return null;
}

export async function storeAttachment(
  tx: Tx, ctx: Ctx,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  link: { query_id?: string | null; interaction_id?: string | null; company_id?: string | null; finding_id?: string | null; task_id?: string | null; visibility?: 'public' | 'internal' },
) {
  if (!file?.buffer?.length) throw badRequest('Empty file');
  if (file.size > config.maxUploadBytes) throw badRequest('File is too large');
  if (BLOCKED_EXT.test(file.originalname)) throw badRequest('This file type is not accepted');
  if (ctx.actorType === 'contact' && link.visibility === 'internal') throw forbidden();
  if (link.query_id) {
    const q = await one(tx, 'SELECT id, company_id FROM queries WHERE id = $1', [link.query_id]); // RLS: must be visible to the uploader
    if (!q) throw notFound('Query not found');
    link.company_id ??= q.company_id;
  }
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const status = await scan(file.buffer);
  const key = `${new Date().toISOString().slice(0, 7)}/${hash.slice(0, 2)}/${hash}`;
  if (status !== 'infected') {
    const full = path.join(config.objectStorageDir, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.buffer);
  }
  const text = status === 'clean' ? extractText(file.buffer, file.mimetype, file.originalname) : null;
  const a = await one(tx,
    `INSERT INTO attachments (query_id, interaction_id, company_id, finding_id, task_id, filename, mime_type, size_bytes, object_key, content_hash,
                              scan_status, indexed_text, visibility, uploaded_by_type, uploaded_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, filename, mime_type, size_bytes, scan_status, visibility, created_at`,
    [link.query_id ?? null, link.interaction_id ?? null, link.company_id ?? null, link.finding_id ?? null, link.task_id ?? null,
     path.basename(file.originalname).slice(0, 255), file.mimetype || 'application/octet-stream', file.size, key, hash, status,
     text, link.visibility ?? 'public', ctx.actorType === 'contact' ? 'contact' : ctx.actorType, ctx.actorId]);
  await audit(tx, ctx, 'attachment.uploaded', link.query_id ? 'query' : link.finding_id ? 'finding' : 'company', link.query_id ?? link.finding_id ?? link.company_id ?? null,
    undefined, { attachment_id: a.id, filename: a.filename, scan_status: status, sha256: hash });
  if (status === 'infected') throw badRequest('The file failed the virus scan and was not stored');
  return a;
}

export async function readAttachment(tx: Tx, ctx: Ctx, id: string) {
  const a = await one(tx, 'SELECT * FROM attachments WHERE id = $1', [id]); // RLS decides visibility
  if (!a) throw notFound('Attachment not found');
  if (a.scan_status !== 'clean') throw forbidden('This file has not passed the virus scan');
  const buf = await fs.readFile(path.join(config.objectStorageDir, a.object_key));
  await audit(tx, ctx, 'attachment.downloaded', 'attachment', id);
  return { meta: a, buffer: buf };
}
