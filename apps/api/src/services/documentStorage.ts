import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { withTenantTransaction } from './tenantService';

export interface ObjectStorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalObjectStorageProvider implements ObjectStorageProvider {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    const target = path.resolve(this.baseDir, key);
    if (!target.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new AppError(ErrorCodes.documentInvalid, 'Invalid storage key', 400);
    }
    return target;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

export interface DocumentRow {
  id: string;
  type: string;
  status: string;
  latest_version_id: string | null;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  created_at: string;
}

export async function uploadDocument(
  pool: Db,
  tenantId: string,
  userId: string,
  storage: ObjectStorageProvider,
  input: {
    originalFilename: string;
    mimeType: string;
    data: Buffer;
    documentType: string;
  },
): Promise<DocumentRow> {
  if (input.data.length === 0) {
    throw new AppError(ErrorCodes.documentInvalid, 'Empty file is not allowed', 400);
  }
  if (input.data.length > 10 * 1024 * 1024) {
    throw new AppError(ErrorCodes.documentTooLarge, 'File exceeds 10 MB limit', 413);
  }
  const allowed = new Map([
    ['application/pdf', 'pdf'],
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
  ]);
  const ext = allowed.get(input.mimeType);
  if (!ext) {
    throw new AppError(ErrorCodes.documentInvalid, 'File type not allowed', 415);
  }
  const sha256 = createHashHex(input.data);
  const storageKey = `${tenantId}/${randomUUID()}.${ext}`;
  await storage.put(storageKey, input.data);

  try {
    return await withTenantTransaction(pool, tenantId, async (client) => {
      const doc = await client.query(
        `INSERT INTO documents (tenant_id, type, status, created_by)
         VALUES ($1, $2, 'UPLOADED', $3)
         RETURNING id, type, status, created_at`,
        [tenantId, input.documentType || 'GENERAL', userId],
      );
      const docId = String(doc.rows[0]!.id);
      const version = await client.query(
        `INSERT INTO document_versions
           (tenant_id, document_id, version_number, storage_key, original_filename,
            mime_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          tenantId,
          docId,
          storageKey,
          input.originalFilename.slice(0, 255),
          input.mimeType,
          input.data.length,
          sha256,
          userId,
        ],
      );
      return {
        id: docId,
        type: String(doc.rows[0]!.type),
        status: String(doc.rows[0]!.status),
        latest_version_id: String(version.rows[0]!.id),
        original_filename: input.originalFilename.slice(0, 255),
        mime_type: input.mimeType,
        size_bytes: String(input.data.length),
        sha256,
        created_at: String(doc.rows[0]!.created_at),
      };
    });
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

function createHashHex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function listDocuments(pool: Db, tenantId: string): Promise<DocumentRow[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT d.id, d.type, d.status, d.created_at,
              dv.id AS latest_version_id, dv.original_filename, dv.mime_type,
              dv.size_bytes, dv.sha256
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT id, original_filename, mime_type, size_bytes, sha256
         FROM document_versions
         WHERE document_id = d.id
         ORDER BY version_number DESC
         LIMIT 1
       ) dv ON true
       ORDER BY d.created_at DESC`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      type: String(row.type),
      status: String(row.status),
      latest_version_id: row.latest_version_id ? String(row.latest_version_id) : null,
      original_filename: row.original_filename ? String(row.original_filename) : null,
      mime_type: row.mime_type ? String(row.mime_type) : null,
      size_bytes: row.size_bytes === null ? null : String(row.size_bytes),
      sha256: row.sha256 ? String(row.sha256) : null,
      created_at: String(row.created_at),
    }));
  });
}

export async function getDocumentDownload(
  pool: Db,
  tenantId: string,
  documentId: string,
): Promise<{ filename: string; mimeType: string; storageKey: string }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT dv.storage_key, dv.original_filename, dv.mime_type
       FROM documents d
       JOIN document_versions dv ON dv.document_id = d.id
       WHERE d.id = $1 AND d.tenant_id = $2
       ORDER BY dv.version_number DESC
       LIMIT 1`,
      [documentId, tenantId],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.documentNotFound, 'Document not found', 404);
    return {
      filename: String(result.rows[0].original_filename),
      mimeType: String(result.rows[0].mime_type),
      storageKey: String(result.rows[0].storage_key),
    };
  });
}

export async function confirmDocument(pool: Db, tenantId: string, documentId: string): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    const latest = await client.query(
      `SELECT dv.id FROM document_versions dv
       WHERE dv.document_id = $1 AND dv.tenant_id = $2
       ORDER BY version_number DESC LIMIT 1`,
      [documentId, tenantId],
    );
    if (!latest.rows[0]) throw new AppError(ErrorCodes.documentNotFound, 'Document not found', 404);
    await client.query(
      `UPDATE document_versions SET confirmed_at = now()
       WHERE id = $1 AND confirmed_at IS NULL`,
      [latest.rows[0].id],
    );
    await client.query(`UPDATE documents SET status = 'CONFIRMED', updated_at = now() WHERE id = $1`, [
      documentId,
    ]);
  });
}
