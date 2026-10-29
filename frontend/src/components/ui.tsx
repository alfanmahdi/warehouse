import type { ReactNode } from 'react';
import type { ApiError } from '../api/client';
import type { DocumentStatus } from '../api/types';

const LABELS: Record<DocumentStatus, string> = {
  OPEN: 'Open',
  PARTIALLY_RECEIVED: 'Partially received',
  FULLY_RECEIVED: 'Fully received',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const StatusBadge = ({ status }: { status: DocumentStatus }) => (
  <span className={`badge badge-${status.toLowerCase()}`}>{LABELS[status]}</span>
);

export const ErrorBanner = ({ error }: { error: ApiError | string | null }) =>
  error ? (
    <div className="banner banner-error" role="alert">
      {typeof error === 'string' ? error : error.friendly}
    </div>
  ) : null;

export const Loading = () => <p className="muted">Loading…</p>;

export function Pagination(props: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const { total, limit, offset, onChange } = props;
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="pagination">
      <button className="btn" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        ← Previous
      </button>
      <span className="muted">
        {from}–{to} of {total}
      </span>
      <button className="btn" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next →
      </button>
    </div>
  );
}

export const PageHeader = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="page-header">
    <h1>{title}</h1>
    <div className="actions">{children}</div>
  </div>
);

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtNum = (n: number) => n.toLocaleString();
