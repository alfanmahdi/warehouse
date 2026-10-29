import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export default function Layout() {
  const { user, logout } = useAuth();
  return (
    <>
      <header className="topbar">
        <strong className="brand">📦 Warehouse Receiving</strong>
        <nav>
          <NavLink to="/receiving">Receiving</NavLink>
          <NavLink to="/inventory" end>
            Inventory
          </NavLink>
          <NavLink to="/inventory/transactions">History</NavLink>
          <NavLink to="/products">Products</NavLink>
        </nav>
        <div className="user">
          <span>
            {user?.fullName} <small className="muted">({user?.role.toLowerCase()})</small>
          </span>
          <button className="btn" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
