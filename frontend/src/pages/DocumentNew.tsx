import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Page, Product, ReceivingDocument } from '../api/types';
import { ErrorBanner, PageHeader } from '../components/ui';

interface Row {
  key: number;
  productId: string;
  quantity: string;
}

let rowKey = 1;
const newRow = (): Row => ({ key: rowKey++, productId: '', quantity: '' });

/** Loads every ACTIVE product (BR-03: inactive ones cannot be added). Capped at 1,000 for the dropdown. */
async function loadActiveProducts(): Promise<Product[]> {
  const all: Product[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const { data } = await api<Page<Product>>('/products', { query: { active: true, limit: 100, offset } });
    all.push(...data.data);
    if (all.length >= data.total) break;
  }
  return all;
}

export default function DocumentNew() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<Product[]>([]);
  const [supplierName, setSupplierName] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadActiveProducts()
      .then(setProducts)
      .catch((e) => setError(e instanceof ApiError ? e : 'Could not load products'));
  }, []);

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Convenience checks only; the backend validates everything again (FR-AUTH-4 / NFR).
    const chosen = rows.filter((r) => r.productId || r.quantity);
    if (chosen.length === 0) return setError('Add at least one item.');
    for (const r of chosen) {
      if (!r.productId) return setError('Choose a product for every item.');
      if (!/^\d+$/.test(r.quantity) || Number(r.quantity) < 1) return setError('Quantities must be whole numbers of at least 1.');
    }
    if (new Set(chosen.map((r) => r.productId)).size !== chosen.length) return setError('Each product can appear only once.');

    setBusy(true);
    try {
      const { data } = await api<ReceivingDocument>('/receiving-documents', {
        method: 'POST',
        body: {
          supplierName,
          referenceNumber: referenceNumber || null,
          expectedDate: expectedDate || null,
          notes: notes || null,
          items: chosen.map((r) => ({ productId: Number(r.productId), expectedQuantity: Number(r.quantity) })),
        },
      });
      navigate(`/receiving/${data.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : 'Could not create document');
      setBusy(false);
    }
  }

  const usedIds = new Set(rows.map((r) => r.productId));

  return (
    <>
      <PageHeader title="New receiving document" />
      <form className="card" onSubmit={submit}>
        <ErrorBanner error={error} />
        <div className="form-grid">
          <label>
            Supplier *
            <input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} maxLength={200} required />
          </label>
          <label>
            Reference (PO / delivery note)
            <input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} maxLength={100} />
          </label>
          <label>
            Expected date
            <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
          </label>
          <label>
            Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
          </label>
        </div>

        <h3>Items</h3>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Expected quantity</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <select value={r.productId} onChange={(e) => update(r.key, { productId: e.target.value })}>
                    <option value="">Select a product…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id} disabled={usedIds.has(String(p.id)) && r.productId !== String(p.id)}>
                        {p.sku} — {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={1}
                    max={1000000}
                    step={1}
                    value={r.quantity}
                    onChange={(e) => update(r.key, { quantity: e.target.value })}
                    aria-label="Expected quantity"
                  />
                </td>
                <td>
                  {rows.length > 1 && (
                    <button type="button" className="btn" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions-row">
          <button type="button" className="btn" disabled={rows.length >= 100} onClick={() => setRows((rs) => [...rs, newRow()])}>
            + Add item
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => navigate('/receiving')}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create document'}
          </button>
        </div>
      </form>
    </>
  );
}
