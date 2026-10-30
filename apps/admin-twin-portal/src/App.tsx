import { lazy, Suspense, useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { LoginGateway } from './components/layout/LoginGateway';
import { Spinner } from './components/ui';
import { useAuthStore } from './store/authStore';
import { usePortalStore } from './store/portalStore';
import type { Role, WorkspaceId } from './types';

// The sign-in gate must not download three.js. Every workspace, including the
// default 3D twin, is fetched once a session exists.
const TwinWorkspace = lazy(() => import('./workspaces/TwinWorkspace').then((module) => ({ default: module.TwinWorkspace })));
const AuditChainLedgerView = lazy(() => import('./workspaces/AuditChainLedgerView').then((module) => ({ default: module.AuditChainLedgerView })));
const DispatchWorkspace = lazy(() => import('./workspaces/DispatchWorkspace').then((module) => ({ default: module.DispatchWorkspace })));
const ExternalIntegrationsConsole = lazy(() => import('./workspaces/ExternalIntegrationsConsole').then((module) => ({ default: module.ExternalIntegrationsConsole })));
const InventoryProcurementView = lazy(() => import('./workspaces/InventoryProcurementView').then((module) => ({ default: module.InventoryProcurementView })));
const AnalyticsWorkspace = lazy(() => import('./workspaces/AnalyticsWorkspace').then((module) => ({ default: module.AnalyticsWorkspace })));
const ModerationQueueView = lazy(() => import('./workspaces/ModerationQueueView').then((module) => ({ default: module.ModerationQueueView })));
const SlaEscalationMonitor = lazy(() => import('./workspaces/SlaEscalationMonitor').then((module) => ({ default: module.SlaEscalationMonitor })));
const TimetableWorkspace = lazy(() => import('./workspaces/TimetableWorkspace').then((module) => ({ default: module.TimetableWorkspace })));

const access: Record<Role, WorkspaceId[]> = {
  MAINTENANCE_TECHNICIAN: ['twin', 'dispatch', 'inventory', 'timetable'],
  INCIDENT_MANAGER: ['twin', 'dispatch', 'sla', 'moderation', 'integrations', 'timetable', 'audit', 'analytics'],
  FACILITIES_ADMIN: ['twin', 'dispatch', 'inventory', 'sla', 'integrations', 'timetable', 'audit', 'analytics'],
  PROCUREMENT_APPROVER: ['twin', 'inventory', 'timetable', 'audit', 'analytics'],
  SYSTEM_ADMIN: ['twin', 'dispatch', 'inventory', 'sla', 'moderation', 'integrations', 'timetable', 'audit', 'analytics'],
  DEPARTMENT_MANAGER: ['twin', 'dispatch', 'sla', 'timetable', 'analytics'],
};

function CurrentWorkspace() {
  const { workspace } = usePortalStore();
  switch (workspace) {
    case 'dispatch': return <DispatchWorkspace />;
    case 'inventory': return <InventoryProcurementView />;
    case 'sla': return <SlaEscalationMonitor />;
    case 'moderation': return <ModerationQueueView />;
    case 'integrations': return <ExternalIntegrationsConsole />;
    case 'timetable': return <TimetableWorkspace />;
    case 'audit': return <AuditChainLedgerView />;
    case 'analytics': return <AnalyticsWorkspace />;
    default: return <TwinWorkspace />;
  }
}

export default function App() {
  const { user, initializing, restore, logout } = useAuthStore();
  const { workspace, setWorkspace } = usePortalStore();
  useEffect(() => { void restore(); }, [restore]);
  useEffect(() => {
    const unauthorized = () => logout();
    window.addEventListener('nosih:unauthorized', unauthorized);
    return () => window.removeEventListener('nosih:unauthorized', unauthorized);
  }, [logout]);
  useEffect(() => {
    if (user && !access[user.role].includes(workspace)) setWorkspace('twin');
  }, [user, workspace, setWorkspace]);
  if (initializing) return <main className="cloth-canvas flex min-h-screen items-center justify-center"><Spinner label="Restoring secure campus session" /></main>;
  if (!user) return <LoginGateway />;
  return <AppShell><Suspense fallback={<Spinner label="Loading workspace" />}><CurrentWorkspace /></Suspense></AppShell>;
}
