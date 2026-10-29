import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DocumentStatus, DocumentSummary, Page } from '../api/types';
import { useApi } from '../api/useApi';
import { ErrorBanner, fmtDate, fmtNum, Loading, PageHeader, Pagination, StatusBadge } from '../components/ui';

const LIMIT = 20;
const STATUSES: DocumentStatus[] = ['OPEN', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'COMPLETED', 'CANCELLED'];

export default function Documents() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<Page<DocumentSummary>>('/receiving-documents', { q, status, limit: LIMIT, offset });

  return (
    <>
      <PageHeader title="Receiving documents">
        <Link className="btn btn-primary" to="/receiving/new">
          + New document
        </Link>
      </PageHeader>
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search number, supplier, reference…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as DocumentStatus | '');
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ').toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Supplier</th>
              <th>Reference</th>
              <th>Status</th>
              <th className="num">Received / expected</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/receiving/${d.id}`}>{d.documentNumber}</Link>
                </td>
                <td>{d.supplierName}</td>
                <td className="muted">{d.referenceNumber ?? '—'}</td>
                <td>
                  <StatusBadge status={d.status} />
                </td>
                <td className="num">
                  {fmtNum(d.totalReceived)} / {fmtNum(d.totalExpected)}
                </td>
                <td className="muted">{fmtDate(d.createdAt)}</td>
              </tr>
            ))}
            {data?.data.length === 0 && (
              <tr>
                <td colSpan={6} className="muted center">
                  No documents found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {data && <Pagination total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </>
  );
}
