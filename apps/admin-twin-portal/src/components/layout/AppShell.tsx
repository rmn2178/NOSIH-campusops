import { useEffect, type ReactNode } from 'react';
import {
  Activity, Archive, BarChart3, Boxes, CalendarRange, ChevronDown, ClipboardList, FileClock,
  GitPullRequestArrow, LogOut, Mail, Radio, ShieldAlert, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import { useTwinSocket } from '../../hooks/useTwinSocket';
import { useAuthStore } from '../../store/authStore';
import { usePortalStore } from '../../store/portalStore';
import type { Role, WorkspaceId } from '../../types';
import { Badge, Button, cx } from '../ui';
import { AssistantDock } from './AssistantDock';

interface NavigationItem {
  id: WorkspaceId;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  roles: Role[];
}

const allRoles: Role[] = ['MAINTENANCE_TECHNICIAN', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN', 'DEPARTMENT_MANAGER'];
const navigation: NavigationItem[] = [
  { id: 'twin', label: 'Digital twin', shortLabel: 'Twin', icon: Boxes, roles: allRoles },
  { id: 'dispatch', label: 'Incidents & dispatch', shortLabel: 'Dispatch', icon: GitPullRequestArrow, roles: ['MAINTENANCE_TECHNICIAN', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'] },
  { id: 'inventory', label: 'Inventory & procurement', shortLabel: 'Inventory', icon: Archive, roles: ['MAINTENANCE_TECHNICIAN', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN'] },
  { id: 'sla', label: 'SLA & escalation', shortLabel: 'SLA', icon: FileClock, roles: ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'] },
  { id: 'moderation', label: 'Moderation & vault', shortLabel: 'Moderation', icon: ShieldAlert, roles: ['INCIDENT_MANAGER', 'SYSTEM_ADMIN'] },
  { id: 'integrations', label: 'External integrations', shortLabel: 'Integrations', icon: Mail, roles: ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'] },
  { id: 'timetable', label: 'Timetable engine', shortLabel: 'Timetable', icon: CalendarRange, roles: allRoles },
  { id: 'analytics', label: 'Campus analytics', shortLabel: 'Analytics', icon: BarChart3, roles: ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN', 'DEPARTMENT_MANAGER'] },
  { id: 'audit', label: 'Audit ledger', shortLabel: 'Audit', icon: ClipboardList, roles: ['INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN'] },
];

const roleLabels: Record<Role, string> = {
  MAINTENANCE_TECHNICIAN: 'Maintenance Technician',
  INCIDENT_MANAGER: 'Incident Manager',
  FACILITIES_ADMIN: 'Facilities Administrator',
  DEPARTMENT_MANAGER: 'Department Manager',
  PROCUREMENT_APPROVER: 'Procurement Approver',
  SYSTEM_ADMIN: 'System Administrator',
};

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuthStore();
  const { workspace, setWorkspace, socketStatus, clock, setClock, notice, clearNotice, selectedSpaceCode } = usePortalStore();
  useTwinSocket(Boolean(user));
  useEffect(() => {
    if (!user) return;
    let active = true;
    const load = () => api.clock.get().then((value) => { if (active) setClock(value); }).catch(() => undefined);
    void load();
    const interval = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [user, setClock]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(clearNotice, 5000);
    return () => window.clearTimeout(timeout);
  }, [notice, clearNotice]);
  if (!user) return null;
  const allowed = navigation.filter((item) => item.roles.includes(user.role));
  const activeItem = allowed.find((item) => item.id === workspace) ?? allowed[0];

  return <div className="cloth-canvas min-h-screen lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-[232px] flex-col border-r border-stitch bg-[#f7f6f1]/95 backdrop-blur-xl lg:flex">
      <div className="flex h-[76px] items-center gap-3 border-b border-stitch px-5"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-obsidian text-white"><Boxes className="h-4 w-4" /></div><div><p className="text-sm font-semibold tracking-[.16em]">NOSIH</p><p className="text-[9px] uppercase tracking-[.17em] text-stone">Campus command</p></div></div>
      <nav className="scrollbar-thin flex-1 space-y-1 overflow-y-auto p-3" aria-label="Admin workspaces">
        <p className="px-3 pb-2 pt-3 text-[9px] font-semibold uppercase tracking-[.2em] text-stone">Operations</p>
        {allowed.map((item) => <button key={item.id} onClick={() => setWorkspace(item.id)} className={cx('group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs transition', activeItem.id === item.id ? 'bg-white font-medium text-obsidian shadow-sm ring-1 ring-stitch' : 'text-stone hover:bg-white/60 hover:text-obsidian')}>
          <item.icon className={cx('h-4 w-4', activeItem.id === item.id ? 'text-obsidian' : 'text-[#89867e]')} /><span>{item.label}</span>{activeItem.id === item.id && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-obsidian" />}
        </button>)}
      </nav>
      <div className="border-t border-stitch p-3"><div className="rounded-xl border border-stitch bg-white p-3"><div className="flex items-center gap-2.5"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-silk text-[11px] font-semibold">{user.full_name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</div><div className="min-w-0"><p className="truncate text-xs font-medium">{user.full_name}</p><p className="truncate text-[9px] text-stone">{roleLabels[user.role]}</p></div></div>
          <Button variant="ghost" size="sm" onClick={logout} className="mt-2 w-full justify-start px-2 text-stone"><LogOut className="h-3.5 w-3.5" />Sign out</Button></div></div>
    </aside>

    <div className="min-w-0 lg:col-start-2">
      <header className="sticky top-0 z-40 flex min-h-[64px] items-center gap-3 border-b border-stitch bg-linen/90 px-4 backdrop-blur-xl sm:px-6">
        <div className="flex items-center gap-2 lg:hidden"><Boxes className="h-5 w-5" /><span className="text-xs font-semibold tracking-widest">NOSIH</span></div>
        <div className="hidden min-w-0 lg:block"><p className="truncate text-xs font-medium">{activeItem.label}</p><p className="text-[9px] uppercase tracking-wider text-stone">NOSIH / {activeItem.id}</p></div>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {clock && <div className="hidden items-center gap-2 border-r border-stitch pr-3 sm:flex"><Activity className="h-3.5 w-3.5 text-stone" /><span className="mono text-[11px]">{clock.day_of_week} · {clock.current_time}</span>{clock.active_period && <Badge tone="cyan">P{clock.active_period} · {clock.minutes_remaining ?? 0}m</Badge>}</div>}
          <Badge tone={socketStatus === 'live' ? 'green' : socketStatus === 'offline' ? 'red' : 'amber'} dot><Radio className="h-3 w-3" />{socketStatus === 'live' ? 'Live' : socketStatus}</Badge>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={logout} aria-label="Sign out"><LogOut className="h-4 w-4" /></Button>
          <ChevronDown className="hidden h-3 w-3 text-stone sm:block" />
        </div>
      </header>
      <div className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-stitch bg-white/60 px-3 py-2 lg:hidden">{allowed.map((item) => <button key={item.id} onClick={() => setWorkspace(item.id)} className={cx('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[11px]', activeItem.id === item.id ? 'bg-obsidian text-white' : 'text-stone')}><item.icon className="h-3.5 w-3.5" />{item.shortLabel}</button>)}</div>
      {selectedSpaceCode && workspace !== 'twin' && <div className="border-b border-cyan-100 bg-cyan-50/60 px-5 py-2 text-center text-[11px] text-cyan-900">Inspector selection: <span className="mono">{selectedSpaceCode}</span> · Return to Digital twin to inspect</div>}
      <main className={workspace === 'twin' ? 'h-[calc(100vh-64px)] min-h-[640px]' : 'mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8'}>{children}</main>
    </div>
    <AssistantDock />
    {notice && <div className="fixed bottom-5 left-1/2 z-[120] flex w-[calc(100%-32px)] max-w-lg -translate-x-1/2 items-center gap-3 rounded-xl border border-emerald-200 bg-white px-4 py-3 text-xs shadow-float"><span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" /><p className="flex-1">{notice}</p><button onClick={clearNotice} aria-label="Dismiss notification"><X className="h-4 w-4 text-stone" /></button></div>}
  </div>;
}
