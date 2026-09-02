import { useEffect, useState } from 'react';
import { api } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';

interface DocumentItem {
  id: string;
  type: string;
  status: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  created_at: string;
}

export function DocumentsPage() {
  const { t } = useI18n();
  const { csrf } = useAuth();
  const [tenantId, setTenantId] = useState('');
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [message, setMessage] = useState('');

  const load = async () => {
    const result = await api<{ documents: DocumentItem[] }>('/api/v1/documents', {
      headers: { 'x-tilivo-tenant-id': tenantId },
    });
    setDocuments(result.documents);
  };

  useEffect(() => {
    api<{ tenants: Array<{ id: string; name: string }> }>('/api/v1/tenants', { csrf })
      .then((result) => {
        if (result.tenants[0]) setTenantId(result.tenants[0].id);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (tenantId) void load().catch(() => undefined);
  }, [tenantId]);

  const upload = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    await fetch('/api/v1/documents', {
      method: 'POST',
      headers: {
        'x-tilivo-tenant-id': tenantId,
        'x-csrf-token': csrf,
      },
      body: form,
    });
    setMessage(t('save'));
    await load();
  };

  return (
    <div className="workspace-page">
      <h2 className="page-title">{t('documents')}</h2>
      <input type="file" onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void upload(file);
      }} />
      {message && <p className="muted">{message}</p>}
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('legalName')}</th>
            <th>{t('status')}</th>
            <th>{t('lastChecked')}</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id}>
              <td>{doc.original_filename ?? doc.id}</td>
              <td>{doc.status}</td>
              <td>{doc.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
