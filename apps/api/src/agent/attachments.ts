/**
 * Quarantine helpers for chat attachments (operator uploads and host downloads).
 * On-disk name is always the UUID; original filename lives in a sidecar meta file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type AttachmentKind = 'text' | 'image' | 'binary';

export interface AttachmentMeta {
  filename: string;
  kind: AttachmentKind;
  contentType: string;
  bytes: number;
}

export interface ChatAttachmentRef {
  id: string;
  filename: string;
  kind: AttachmentKind;
  url: string;
  bytes: number;
}

export function classifyAttachment(filename: string, buffer: Buffer): AttachmentKind {
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename)) return 'image';
  const head = buffer.subarray(0, 8192);
  if (head.includes(0)) return 'binary';
  return 'text';
}

export function contentTypeFor(filename: string, kind: AttachmentKind): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (kind === 'text') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export function attachmentPaths(dir: string, id: string): { data: string; meta: string } {
  return { data: join(dir, id), meta: join(dir, `${id}.meta.json`) };
}

export function writeAttachment(
  dir: string,
  id: string,
  buffer: Buffer,
  filename: string,
): ChatAttachmentRef {
  const kind = classifyAttachment(filename, buffer);
  const contentType = contentTypeFor(filename, kind);
  const { data, meta } = attachmentPaths(dir, id);
  writeFileSync(data, buffer, { mode: 0o600 });
  const record: AttachmentMeta = {
    filename,
    kind,
    contentType,
    bytes: buffer.length,
  };
  writeFileSync(meta, JSON.stringify(record), { mode: 0o600 });
  return {
    id,
    filename,
    kind,
    url: `/api/attachments/${id}`,
    bytes: buffer.length,
  };
}

export function readAttachmentMeta(dir: string, id: string): AttachmentMeta | null {
  const { meta } = attachmentPaths(dir, id);
  if (!existsSync(meta)) return null;
  try {
    return JSON.parse(readFileSync(meta, 'utf8')) as AttachmentMeta;
  } catch {
    return null;
  }
}
