import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { InventoryItem, Page } from '../api/types';
import { useApi } from '../api/useApi';
import { ErrorBanner, fmtDate, fmtNum, Loading, PageHeader, Pagination } from '../components/ui';

const LIMIT = 25;

export default function Inventory() {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<Page<InventoryItem>>('/inventory', { q, limit: LIMIT, offset });

  return (
    <>
      <PageHeader title="Inventory" />
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
      {loading && !data ? (
        <Loading />
      ) : (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th className="num">On hand</th>
              <th>Last movement</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.data.map((i) => (
              <tr key={i.productId} className={i.isActive ? '' : 'dim'}>
                <td>
                  <code>{i.sku}</code>
                </td>
                <td>{i.name}</td>
                <td className="num">
                  <strong>{fmtNum(i.quantityOnHand)}</strong>
                </td>
                <td className="muted">{fmtDate(i.updatedAt)}</td>
                <td>
                  <Link to={`/inventory/transactions?productId=${i.productId}`}>History</Link>
                </td>
              </tr>
            ))}
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
