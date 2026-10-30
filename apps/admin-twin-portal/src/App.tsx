import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { LoginGateway } from './components/layout/LoginGateway';
import { Spinner } from './components/ui';
import { useAuthStore } from './store/authStore';
import { usePortalStore } from './store/portalStore';
import type { Role, WorkspaceId } from './types';
import { AuditChainLedgerView } from './workspaces/AuditChainLedgerView';
import { DispatchWorkspace } from './workspaces/DispatchWorkspace';
import { ExternalIntegrationsConsole } from './workspaces/ExternalIntegrationsConsole';
import { InventoryProcurementView } from './workspaces/InventoryProcurementView';
import { AnalyticsWorkspace } from './workspaces/AnalyticsWorkspace';
import { ModerationQueueView } from './workspaces/ModerationQueueView';
import { SlaEscalationMonitor } from './workspaces/SlaEscalationMonitor';
import { TimetableWorkspace } from './workspaces/TimetableWorkspace';
import { TwinWorkspace } from './workspaces/TwinWorkspace';

const access: Record<Role, WorkspaceId[]> = {
  MAINTENANCE_TECHNICIAN: ['twin', 'dispatch', 'inventory', 'timetable'],
  INCIDENT_MANAGER: ['twin', 'dispatch', 'sla', 'moderation', 'integrations', 'timetable', 'audit', 'analytics'],
  FACILITIES_ADMIN: ['twin', 'dispatch', 'inventory', 'sla', 'integrations', 'timetable', 'audit', 'analytics'],
  PROCUREMENT_APPROVER: ['twin', 'inventory', 'timetable', 'audit', 'analytics'],
  SYSTEM_ADMIN: ['twin', 'dispatch', 'inventory', 'sla', 'moderation', 'integrations', 'timetable', 'audit', 'analytics'],
  DEPARTMENT_MANAGER: ['twin', 'dispatch', 'inventory', 'sla', 'timetable', 'audit', 'analytics'],
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
  return <AppShell><CurrentWorkspace /></AppShell>;
}
