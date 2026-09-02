import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { writeAuditEvent } from '../services/audit';
import {
  confirmDocument,
  getDocumentDownload,
  listDocuments,
  LocalObjectStorageProvider,
  uploadDocument,
  type ObjectStorageProvider,
} from '../services/documentStorage';
import { resolveSessionUser } from '../services/sessionContext';
import { requirePermission, resolveTenantAccess } from '../services/tenantService';

interface DocumentRouteOptions {
  db: Db;
  config: AppConfig;
  storage: ObjectStorageProvider;
}

const TENANT_HEADER = 'x-tilivo-tenant-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function tenantContext(request: FastifyRequest, db: Db, config: AppConfig): Promise<{ userId: string; tenantId: string }> {
  const { user } = await resolveSessionUser(db, request, config);
  const value = request.headers[TENANT_HEADER];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(ErrorCodes.tenantInvalid, 'Valid tenant id is required', 400);
  }
  const tenantId = value.toLowerCase();
  await resolveTenantAccess(db, user.id, tenantId);
  return { userId: user.id, tenantId };
}

export async function documentRoutes(app: FastifyInstance, options: DocumentRouteOptions): Promise<void> {
  const { db, config, storage } = options;

  app.get('/api/v1/documents', async (request) => {
    const { userId, tenantId } = await tenantContext(request, db, config);
    await requirePermission(db, userId, tenantId, 'document.read');
    const documents = await listDocuments(db, tenantId);
    return { documents };
  });

  app.post('/api/v1/documents', async (request, reply) => {
    const { userId, tenantId } = await tenantContext(request, db, config);
    await requirePermission(db, userId, tenantId, 'document.upload');
    const part = await request.file();
    if (!part) throw new AppError(ErrorCodes.documentInvalid, 'File part is required', 400);
    const data = await part.toBuffer();
    const document = await uploadDocument(db, tenantId, userId, storage, {
      originalFilename: part.filename,
      mimeType: part.mimetype,
      data,
      documentType: 'GENERAL',
    });
    await writeAuditEvent(db, 'DOCUMENT.UPLOADED', request, {
      userId,
      tenantId,
      objectType: 'DOCUMENT',
      objectId: document.id,
      metadata: { sha256: document.sha256 },
    });
    return reply.code(201).send({ document });
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/documents/:id/confirm',
    async (request, reply) => {
      const { userId, tenantId } = await tenantContext(request, db, config);
      await requirePermission(db, userId, tenantId, 'document.manage');
      await confirmDocument(db, tenantId, request.params.id);
      await writeAuditEvent(db, 'DOCUMENT.CONFIRMED', request, {
        userId,
        tenantId,
        objectType: 'DOCUMENT',
        objectId: request.params.id,
      });
      return reply.send({ message: 'Document confirmed' });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/documents/:id/download',
    async (request, reply) => {
      const { userId, tenantId } = await tenantContext(request, db, config);
      await requirePermission(db, userId, tenantId, 'document.read');
      const meta = await getDocumentDownload(db, tenantId, request.params.id);
      const data = await storage.get(meta.storageKey);
      await writeAuditEvent(db, 'DOCUMENT.DOWNLOADED', request, {
        userId,
        tenantId,
        objectType: 'DOCUMENT',
        objectId: request.params.id,
      });
      return reply
        .type(meta.mimeType)
        .header('Content-Disposition', `inline; filename="${sanitizeFilename(meta.filename)}"`)
        .send(data);
    },
  );
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, '_').slice(0, 120);
}

export { LocalObjectStorageProvider };
