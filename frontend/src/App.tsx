import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import DocumentDetail from './pages/DocumentDetail';
import DocumentNew from './pages/DocumentNew';
import Documents from './pages/Documents';
import Inventory from './pages/Inventory';
import Login from './pages/Login';
import Products from './pages/Products';
import Transactions from './pages/Transactions';

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/receiving" replace />} />
        <Route path="receiving" element={<Documents />} />
        <Route path="receiving/new" element={<DocumentNew />} />
        <Route path="receiving/:id" element={<DocumentDetail />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="inventory/transactions" element={<Transactions />} />
        <Route path="products" element={<Products />} />
        <Route path="*" element={<Navigate to="/receiving" replace />} />
      </Route>
    </Routes>
  );
}
