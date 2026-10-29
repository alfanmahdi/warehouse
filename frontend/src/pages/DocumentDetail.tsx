import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, newKey } from '../api/client';
import type { ReceivingDocument } from '../api/types';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, fmtDate, fmtNum, Loading, PageHeader, StatusBadge } from '../components/ui';

export default function DocumentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: doc, error, loading, reload } = useApi<ReceivingDocument>(`/receiving-documents/${id}`);

  const [qty, setQty] = useState<Record<number, string>>({});
  const [actionError, setActionError] = useState<ApiError | string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One Idempotency-Key per distinct payload: a retry of the SAME submission (e.g. after a network error)
  // reuses the key and cannot double-count; a changed payload or a successful submit gets a fresh key.
  const keyRef = useRef<{ payload: string; key: string } | null>(null);

  if (loading && !doc) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!doc) return null;

  const canReceive = doc.status === 'OPEN' || doc.status === 'PARTIALLY_RECEIVED';
  const canComplete = doc.status === 'FULLY_RECEIVED' && can('SUPERVISOR');
  const canCancel = doc.status === 'OPEN' && can('SUPERVISOR');

  async function submitReceipt(e: FormEvent) {
    e.preventDefault();
    if (!doc || busy) return; // blocks double submission while a request is in flight
    setActionError(null);
    setNotice(null);

    const lines: Array<{ itemId: number; quantity: number }> = [];
    for (const item of doc.items) {
      const raw = (qty[item.id] ?? '').trim();
      if (raw === '') continue;
      if (!/^\d+$/.test(raw) || Number(raw) < 1) return setActionError(`${item.sku}: enter a whole number of at least 1.`);
      if (Number(raw) > item.remainingQuantity)
        return setActionError(`${item.sku}: only ${fmtNum(item.remainingQuantity)} remaining — cannot receive ${fmtNum(Number(raw))}.`);
      lines.push({ itemId: item.id, quantity: Number(raw) });
    }
    if (lines.length === 0) return setActionError('Enter a received quantity for at least one item.');

    const payload = JSON.stringify(lines);
    if (!keyRef.current || keyRef.current.payload !== payload) keyRef.current = { payload, key: newKey() };

    setBusy(true);
    try {
      const res = await api<{ receipt: { id: number }; document: ReceivingDocument }>(`/receiving-documents/${doc.id}/receipts`, {
        method: 'POST',
        body: { lines },
        headers: { 'Idempotency-Key': keyRef.current.key },
      });
      keyRef.current = null;
      setQty({});
      setNotice(res.status === 200 ? 'This receipt was already recorded — nothing was changed.' : 'Receipt recorded.');
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err : 'Could not record receipt');
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) keyRef.current = null; // definite rejection: next try is a new attempt
      if (err instanceof ApiError && err.status === 409) reload(); // state changed under us
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: 'complete' | 'cancel') {
    if (!doc || busy) return;
    const text = kind === 'complete' ? 'Complete this document? It cannot be changed afterwards.' : 'Cancel this document? This cannot be undone.';
    if (!window.confirm(text)) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api(`/receiving-documents/${doc.id}/${kind}`, { method: 'POST' });
      setNotice(kind === 'complete' ? 'Document completed.' : 'Document cancelled.');
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err : 'Action failed');
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={doc.documentNumber}>
        <Link className="btn" to="/receiving">
          ← All documents
        </Link>
        {canComplete && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act('complete')}>
            Complete document
          </button>
        )}
        {canCancel && (
          <button className="btn btn-danger" disabled={busy} onClick={() => act('cancel')}>
            Cancel document
          </button>
        )}
      </PageHeader>

      <div className="card meta">
        <div>
          <span className="muted">Status</span>
          <StatusBadge status={doc.status} />
        </div>
        <div>
          <span className="muted">Supplier</span>
          {doc.supplierName}
        </div>
        <div>
          <span className="muted">Reference</span>
          {doc.referenceNumber ?? '—'}
        </div>
        <div>
          <span className="muted">Expected date</span>
          {doc.expectedDate ?? '—'}
        </div>
        <div>
          <span className="muted">Created</span>
          {fmtDate(doc.createdAt)} by {doc.createdBy.fullName}
        </div>
        {doc.completedAt && (
          <div>
            <span className="muted">Completed</span>
            {fmtDate(doc.completedAt)} by {doc.completedBy?.fullName}
          </div>
        )}
        {doc.cancelledAt && (
          <div>
            <span className="muted">Cancelled</span>
            {fmtDate(doc.cancelledAt)} by {doc.cancelledBy?.fullName}
          </div>
        )}
        {doc.notes && (
          <div className="wide">
            <span className="muted">Notes</span>
            {doc.notes}
          </div>
        )}
      </div>

      {notice && <div className="banner banner-ok">{notice}</div>}
      <ErrorBanner error={actionError} />

      <form onSubmit={submitReceipt}>
        <h2>Items</h2>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th className="num">Expected</th>
              <th className="num">Received</th>
              <th className="num">Remaining</th>
              {canReceive && <th className="num">Receive now</th>}
            </tr>
          </thead>
          <tbody>
            {doc.items.map((i) => (
              <tr key={i.id}>
                <td>
                  <code>{i.sku}</code>
                </td>
                <td>{i.productName}</td>
                <td className="num">{fmtNum(i.expectedQuantity)}</td>
                <td className="num">{fmtNum(i.receivedQuantity)}</td>
                <td className="num">{i.remainingQuantity === 0 ? '✓' : fmtNum(i.remainingQuantity)}</td>
                {canReceive && (
                  <td className="num">
                    <input
                      type="number"
                      min={1}
                      max={i.remainingQuantity}
                      step={1}
                      disabled={i.remainingQuantity === 0 || busy}
                      value={qty[i.id] ?? ''}
                      onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))}
                      aria-label={`Receive quantity for ${i.sku}`}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {canReceive && (
          <div className="actions-row">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setQty(Object.fromEntries(doc.items.filter((i) => i.remainingQuantity > 0).map((i) => [i.id, String(i.remainingQuantity)])))}
            >
              Fill all remaining
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setQty({})}>
              Clear
            </button>
            <span className="spacer" />
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Recording…' : 'Record receipt'}
            </button>
          </div>
        )}
        {!canReceive && (
          <p className="muted">
            {doc.status === 'FULLY_RECEIVED' && 'Everything has been received. A supervisor can now complete the document.'}
            {doc.status === 'COMPLETED' && 'This document is completed and can no longer be changed.'}
            {doc.status === 'CANCELLED' && 'This document was cancelled.'}
          </p>
        )}
      </form>

      <h2>Receipts</h2>
      {doc.receipts.length === 0 ? (
        <p className="muted">Nothing has been received yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>When</th>
              <th>By</th>
              <th>Lines</th>
            </tr>
          </thead>
          <tbody>
            {[...doc.receipts].reverse().map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td className="muted">{fmtDate(r.createdAt)}</td>
                <td>{r.receivedBy.fullName}</td>
                <td>
                  {r.lines.map((l) => (
                    <div key={l.itemId}>
                      <code>{l.sku}</code> +{fmtNum(l.quantity)} <span className="muted">(stock now {fmtNum(l.balanceAfter)})</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
