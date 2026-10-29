import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Building2, FilePlus2, LogOut, MessageSquareText } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { cx, roleLabel } from '../lib/format';
import { AssistantPanel } from './AssistantPanel';

export function PortalLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-stitch/90 bg-linen/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center gap-5 px-4 sm:px-6 lg:px-10">
          <NavLink to="/feed" className="flex shrink-0 items-center gap-3" aria-label="NOSIH campus feed">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-stitch bg-white shadow-cloth">
              <Building2 size={20} strokeWidth={1.6} />
            </span>
            <span className="hidden sm:block">
              <span className="block text-sm font-bold tracking-[0.18em]">NOSIH</span>
              <span className="block text-[10px] uppercase tracking-[0.12em] text-stone">Campus register</span>
            </span>
          </NavLink>

          <nav className="ml-2 flex items-center gap-1" aria-label="Primary navigation">
            <NavLink
              to="/feed"
              className={({ isActive }) => cx('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition', isActive ? 'bg-white text-ink shadow-sm' : 'text-stone hover:bg-white/60 hover:text-ink')}
            >
              <MessageSquareText size={17} />
              <span className="hidden md:inline">Campus feed</span>
            </NavLink>
            <NavLink
              to="/complaints/new"
              className={({ isActive }) => cx('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition', isActive ? 'bg-ink text-white' : 'text-stone hover:bg-white/60 hover:text-ink')}
            >
              <FilePlus2 size={17} />
              <span className="hidden sm:inline">New complaint</span>
            </NavLink>
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-3">
            {user && (
              <div className="hidden items-center gap-3 lg:flex">
                <div className="text-right">
                  <p className="text-xs font-semibold text-ink">{user.full_name}</p>
                  <p className="mt-0.5 text-[11px] text-stone">
                    {user.department} · {roleLabel(user.academic_role)}
                    {user.section ? ` · Section ${user.section}` : ''}
                    {user.home_room_code ? <> · <span className="mono">{user.home_room_code}</span></> : ''}
                  </p>
                </div>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-emerald-800">Verified</span>
              </div>
            )}
            <button type="button" className="icon-button" onClick={handleLogout} aria-label="Sign out" title="Sign out">
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </header>

      <main>
        <Outlet />
      </main>

      <footer className="mx-auto flex max-w-[1440px] flex-col gap-2 px-5 py-8 text-[11px] text-stone sm:flex-row sm:items-center sm:justify-between lg:px-10">
        <p>NOSIH · Campus Complaint Register</p>
        <p>Anonymous identities are encrypted and sealed by the campus vault.</p>
      </footer>

      <AssistantPanel />
    </div>
  );
}
