import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Building2, Check, ChevronDown, LoaderCircle, LockKeyhole, Mail, Search, ShieldCheck } from 'lucide-react';
import { api, DEPARTMENTS } from '../api/client';
import type { AcademicRole, Department, DirectoryEntry } from '../api/client';
import { cx, roleLabel } from '../lib/format';
import { useAuthStore } from '../store/useAuthStore';

const roles: AcademicRole[] = ['YEAR_1', 'YEAR_2', 'YEAR_3', 'FACULTY_STAFF'];
const institutionalEmail = /^[^\s@]+@(nosih\.edu\.in|college\.edu)$/i;

export function LoginGatewayPage() {
  const navigate = useNavigate();
  const { token, setSession } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [department, setDepartment] = useState<Department>('CSE');
  const [academicRole, setAcademicRole] = useState<AcademicRole>('YEAR_1');
  const [suggestions, setSuggestions] = useState<DirectoryEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const blurTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const query = email.trim();
    if (query.length < 2 || !directoryOpen) {
      setSuggestions([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await api.searchDirectory(query, controller.signal);
        setSuggestions(results);
      } catch (requestError) {
        if (!controller.signal.aborted) setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 280);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [email, directoryOpen]);

  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  if (token) return <Navigate to="/feed" replace />;

  const selectDirectoryEntry = (entry: DirectoryEntry) => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setEmail(entry.email);
    setDepartment(entry.department);
    setAcademicRole(entry.academic_role);
    setDirectoryOpen(false);
    setSuggestions([]);
    setError('');
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!institutionalEmail.test(normalizedEmail)) {
      setError('Enter an institutional email ending in @nosih.edu.in or @college.edu.');
      return;
    }
    if (password.length < 6) {
      setError('Enter your password (at least 6 characters). Demo accounts use Nosih@2026.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const session = await api.login({
        email: normalizedEmail,
        password,
        department,
        academic_role: academicRole,
      });
      setSession(session);
      navigate('/feed', { replace: true });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute left-[8%] top-[8%] h-40 w-40 rounded-full border border-stitch/60" />
      <div className="pointer-events-none absolute bottom-[5%] right-[7%] h-64 w-64 rounded-full border border-stitch/50" />
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="hidden lg:block"
        >
          <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-2xl border border-stitch bg-white shadow-cloth">
            <Building2 size={27} strokeWidth={1.5} />
          </div>
          <p className="eyebrow mb-5">Campus care, made visible</p>
          <h1 className="max-w-lg text-5xl font-semibold leading-[1.08] tracking-[-0.045em] text-ink">
            One register.<br />A healthier campus.
          </h1>
          <p className="mt-6 max-w-md text-base leading-7 text-stone">
            Report facility issues, add evidence, and follow the campus response in real time. Your voice helps every room work better.
          </p>
          <div className="mt-10 grid max-w-md grid-cols-3 gap-3">
            {[
              ['90', 'Classrooms'],
              ['20', 'Specialist labs'],
              ['24×7', 'Community feed'],
            ].map(([value, label]) => (
              <div key={label} className="border-l border-stitch pl-4">
                <p className="mono text-lg font-medium">{value}</p>
                <p className="mt-1 text-[11px] leading-4 text-stone">{label}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 flex items-center gap-2 text-xs text-stone">
            <ShieldCheck size={16} /> Privacy-protected anonymous reporting
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08 }}
          className="cloth-card mx-auto w-full max-w-xl p-6 sm:p-9"
        >
          <div className="mb-8 flex items-center justify-between">
            <div>
              <p className="eyebrow">Identity gateway</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Welcome to NOSIH</h2>
            </div>
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-stitch bg-silk lg:hidden">
              <Building2 size={21} />
            </span>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className="relative">
              <label htmlFor="email" className="field-label">College email ID</label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-4 top-3.5 text-stone" size={17} />
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  className="field pl-11 pr-11"
                  placeholder="you@nosih.edu.in"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setDirectoryOpen(true);
                    setError('');
                  }}
                  onFocus={() => setDirectoryOpen(true)}
                  onBlur={() => {
                    blurTimer.current = setTimeout(() => setDirectoryOpen(false), 120);
                  }}
                  role="combobox"
                  aria-expanded={directoryOpen && (suggestions.length > 0 || searching)}
                  aria-controls="directory-results"
                  aria-autocomplete="list"
                  required
                />
                {searching
                  ? <LoaderCircle className="absolute right-4 top-3.5 animate-spin text-stone" size={17} />
                  : <Search className="pointer-events-none absolute right-4 top-3.5 text-stone/60" size={17} />}
              </div>
              <AnimatePresence>
                {directoryOpen && suggestions.length > 0 && (
                  <motion.div
                    id="directory-results"
                    role="listbox"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="absolute z-30 mt-2 w-full overflow-hidden rounded-xl border border-stitch bg-white p-1.5 shadow-lift"
                  >
                    {suggestions.map((entry) => (
                      <button
                        key={entry.email}
                        type="button"
                        role="option"
                        aria-selected={entry.email === email}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectDirectoryEntry(entry)}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-silk"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{entry.full_name}</span>
                          <span className="block truncate text-xs text-stone">{entry.email}</span>
                        </span>
                        <span className="shrink-0 text-[10px] text-stone">{entry.department} · {roleLabel(entry.academic_role)}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
              <p className="mt-2 text-[11px] text-stone">Search the campus directory or enter any valid institutional email.</p>
            </div>

            <div className="mt-5">
              <label htmlFor="password" className="field-label">Password</label>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute left-4 top-3.5 text-stone" size={17} />
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  className="field pl-11"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError('');
                  }}
                  minLength={6}
                  required
                />
              </div>
              <p className="mt-2 text-[11px] text-stone">Demo staff accounts use Nosih@2026.</p>
            </div>

            <div className="mt-5">
              <label htmlFor="department" className="field-label">Department</label>
              <div className="relative">
                <select
                  id="department"
                  className="field appearance-none pr-10"
                  value={department}
                  onChange={(event) => setDepartment(event.target.value as Department)}
                >
                  {DEPARTMENTS.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-4 top-3.5 text-stone" size={17} />
              </div>
            </div>

            <fieldset className="mt-5">
              <legend className="field-label">Year / academic role</legend>
              <div className="grid grid-cols-2 gap-1 rounded-xl border border-stitch bg-silk p-1 sm:grid-cols-4">
                {roles.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setAcademicRole(role)}
                    aria-pressed={academicRole === role}
                    className={cx('rounded-lg px-2 py-2.5 text-xs font-medium transition', academicRole === role ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink')}
                  >
                    {roleLabel(role)}
                  </button>
                ))}
              </div>
            </fieldset>

            <AnimatePresence>
              {error && (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-5 text-red-800"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <button type="submit" className="btn-primary mt-7 w-full" disabled={submitting}>
              {submitting ? <LoaderCircle size={17} className="animate-spin" /> : <LockKeyhole size={17} />}
              {submitting ? 'Verifying identity…' : 'Enter campus portal'}
              {!submitting && <ArrowRight size={17} />}
            </button>
          </form>

          <div className="mt-6 flex items-start gap-2 border-t border-stitch pt-5 text-[11px] leading-5 text-stone">
            <Check size={14} className="mt-0.5 shrink-0 text-emerald-700" />
            Your department, year, section, and home room are verified by NOSIH when you sign in.
          </div>
        </motion.section>
      </div>
    </main>
  );
}
