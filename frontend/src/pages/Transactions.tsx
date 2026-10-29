import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { InventoryTransaction, Page } from '../api/types';
import { useApi } from '../api/useApi';
import { ErrorBanner, fmtDate, fmtNum, Loading, PageHeader, Pagination } from '../components/ui';

const LIMIT = 25;

export default function Transactions() {
  const [params, setParams] = useSearchParams();
  const productId = params.get('productId') ?? '';
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<Page<InventoryTransaction>>('/inventory/transactions', { productId, limit: LIMIT, offset });

  return (
    <>
      <PageHeader title="Inventory history">
        {productId && (
          <button
            className="btn"
            onClick={() => {
              setParams({});
              setOffset(0);
            }}
          >
            Show all products
          </button>
        )}
      </PageHeader>
      {productId && <p className="muted">Filtered by product #{productId}</p>}
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>SKU</th>
              <th>Product</th>
              <th>Type</th>
              <th className="num">Change</th>
              <th className="num">Balance after</th>
              <th>Document</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((t) => (
              <tr key={t.id}>
                <td className="muted">{fmtDate(t.createdAt)}</td>
                <td>
                  <code>{t.sku}</code>
                </td>
                <td>{t.productName}</td>
                <td>{t.type}</td>
                <td className="num pos">+{fmtNum(t.quantityChange)}</td>
                <td className="num">{fmtNum(t.balanceAfter)}</td>
                <td>
                  <Link to={`/receiving/${t.documentId}`}>{t.documentNumber}</Link>
                </td>
                <td>{t.createdBy.fullName}</td>
              </tr>
            ))}
            {data?.data.length === 0 && (
              <tr>
                <td colSpan={8} className="muted center">
                  No transactions yet.
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
