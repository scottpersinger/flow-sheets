import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AgentPanel } from './agent/AgentPanel.tsx';
import { AgentProvider, useAgent } from './agent/AgentProvider.tsx';
import { AuthProvider, useAuth } from './auth.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { ChangesPage } from './pages/ChangesPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { SpreadsheetPage } from './pages/SpreadsheetPage.tsx';
import './styles.css';

function RequireAuth({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function GuestOnly({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loading">Loading…</div>;
  if (user) return <Navigate to="/" replace />;
  return children;
}

/** The pages, with the assistant panel docked on the right when it is open. */
function AppShell() {
  const { user } = useAuth();
  const { open } = useAgent();
  return (
    <div className="app-shell">
      <div className="app-main">
        <Routes>
          <Route path="/login" element={<GuestOnly><AuthPage mode="login" /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><AuthPage mode="register" /></GuestOnly>} />
          <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
          <Route path="/s/:id" element={<RequireAuth><SpreadsheetPage /></RequireAuth>} />
          <Route path="/changes" element={<RequireAuth><ChangesPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {user && open && <AgentPanel />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <AgentProvider>
          <AppShell />
        </AgentProvider>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
