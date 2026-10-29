import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PortalLayout } from './components/PortalLayout';
import { CampusFeedPage } from './pages/CampusFeedPage';
import { LoginGatewayPage } from './pages/LoginGatewayPage';
import { NewComplaintPage } from './pages/NewComplaintPage';
import { useAuthStore } from './store/useAuthStore';

function ProtectedApp() {
  const token = useAuthStore((state) => state.token);
  const hasHydrated = useAuthStore((state) => state.hasHydrated);

  if (!hasHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-stitch border-t-ink" />
        <span className="sr-only">Restoring your session</span>
      </div>
    );
  }

  return token ? <PortalLayout /> : <Navigate to="/login" replace />;
}

export default function App() {
  const initialize = useAuthStore((state) => state.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  return (
    <Routes>
      <Route path="/login" element={<LoginGatewayPage />} />
      <Route element={<ProtectedApp />}>
        <Route path="/feed" element={<CampusFeedPage />} />
        <Route path="/complaints/new" element={<NewComplaintPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/feed" replace />} />
    </Routes>
  );
}
