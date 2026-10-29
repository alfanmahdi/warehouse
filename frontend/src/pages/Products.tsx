import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { Page, Product } from '../api/types';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, Loading, PageHeader, Pagination } from '../components/ui';

const LIMIT = 20;

export default function Products() {
  const { can } = useAuth();
  const isSupervisor = can('SUPERVISOR');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useApi<Page<Product>>('/products', { q, limit: LIMIT, offset });

  const [showForm, setShowForm] = useState(false);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<Product | null>(null);
  const [rowError, setRowError] = useState<ApiError | string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/products', { method: 'POST', body: { sku, name, description: description || null } });
      setSku('');
      setName('');
      setDescription('');
      setShowForm(false);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err : 'Could not create product');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    setRowError(null);
    try {
      await api(`/products/${id}`, { method: 'PATCH', body });
      setEditing(null);
      reload();
    } catch (err) {
      setRowError(err instanceof ApiError ? err : 'Could not update product');
    }
  }

  return (
    <>
      <PageHeader title="Products">
        {isSupervisor && (
          <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Close' : '+ New product'}
          </button>
        )}
      </PageHeader>

      {showForm && (
        <form className="card form-grid" onSubmit={create}>
          <ErrorBanner error={formError} />
          <label>
            SKU *
            <input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={32} placeholder="e.g. WIDGET-001" required />
            <small className="muted">Letters, digits, - and _. Stored in upper case; cannot be changed later.</small>
          </label>
          <label>
            Name *
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          </label>
          <label>
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
          </label>
          <div>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Create product'}
            </button>
          </div>
        </form>
      )}

      <input
        className="search"
        type="search"
        placeholder="Search SKU or name…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOffset(0);
        }}
      />
      <ErrorBanner error={error} />
      <ErrorBanner error={rowError} />
      {loading && !data ? (
        <Loading />
      ) : (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>Description</th>
              <th>Status</th>
              {isSupervisor && <th />}
            </tr>
          </thead>
          <tbody>
            {data?.data.map((p) =>
              editing?.id === p.id ? (
                <tr key={p.id}>
                  <td>
                    <code>{p.sku}</code>
                  </td>
                  <td>
                    <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  </td>
                  <td>
                    <input
                      value={editing.description ?? ''}
                      onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                    />
                  </td>
                  <td />
                  <td className="row-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => patch(p.id, { name: editing.name, description: editing.description || null })}
                    >
                      Save
                    </button>
                    <button className="btn" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={p.id} className={p.isActive ? '' : 'dim'}>
                  <td>
                    <code>{p.sku}</code>
                  </td>
                  <td>{p.name}</td>
                  <td className="muted">{p.description}</td>
                  <td>{p.isActive ? 'Active' : 'Inactive'}</td>
                  {isSupervisor && (
                    <td className="row-actions">
                      <button className="btn" onClick={() => setEditing(p)}>
                        Edit
                      </button>
                      <button className="btn" onClick={() => patch(p.id, { isActive: !p.isActive })}>
                        {p.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  )}
                </tr>
              ),
            )}
            {data?.data.length === 0 && (
              <tr>
                <td colSpan={5} className="muted center">
                  No products found.
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
