import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, FilePlus2, Filter, MessageSquareText, RefreshCw, SlidersHorizontal, Wifi, WifiOff, X } from 'lucide-react';
import { api } from '../api/client';
import type { Complaint, ComplaintFilters, ComplaintStatus } from '../api/client';
import { connectPortalSocket } from '../api/websocket';
import { ComplaintCard } from '../components/ComplaintCard';
import { useAuthStore } from '../store/useAuthStore';
import { cx } from '../lib/format';

const categories = ['ELECTRICAL', 'FANS_HVAC', 'IT_SMARTBOARD', 'PLUMBING', 'FURNITURE', 'LAB_EQUIPMENT', 'CANTEEN_APPLIANCE', 'BILL_BOT', 'SAFETY_FIRE', 'CLEANLINESS'];
const zones: Array<{ value: NonNullable<ComplaintFilters['zone']>; label: string }> = [
  { value: 'ALL', label: 'All zones' },
  { value: 'BLOCK_A', label: 'Block A' },
  { value: 'BLOCK_B', label: 'Block B' },
  { value: 'BLOCK_C', label: 'Block C' },
  { value: 'LABS', label: 'Labs' },
  { value: 'CANTEENS', label: 'Canteens' },
  { value: 'BILL_BOTS', label: 'Bill Bots' },
];
const statuses: Array<{ value: ComplaintStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'BLOCKED_PARTS', label: 'Blocked on Parts' },
  { value: 'RESOLVED', label: 'Resolved' },
];

interface ActiveFilters {
  zone: NonNullable<ComplaintFilters['zone']>;
  status: ComplaintStatus | 'ALL';
  category: string;
  myDepartment: boolean;
}

const initialFilters: ActiveFilters = { zone: 'ALL', status: 'ALL', category: 'ALL', myDepartment: false };

const FEED_CACHE = 'nosih.feed.snapshot.v1';
const filterKey = (filters: ActiveFilters) => JSON.stringify([
  filters.zone, filters.status, filters.category, filters.myDepartment,
]);

function readFeedCache(filters: ActiveFilters): Complaint[] | null {
  try {
    const raw = sessionStorage.getItem(FEED_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key?: string; rows?: Complaint[] };
    if (parsed.key !== filterKey(filters) || !Array.isArray(parsed.rows)) return null;
    return parsed.rows.slice(0, 10);
  } catch {
    return null;
  }
}

function writeFeedCache(filters: ActiveFilters, rows: Complaint[]) {
  try {
    sessionStorage.setItem(FEED_CACHE, JSON.stringify({ key: filterKey(filters), rows }));
  } catch {
    // Storage full or disabled; the live fetch remains the source of truth.
  }
}

function matchesFilters(complaint: Complaint, filters: ActiveFilters, department?: string): boolean {
  if (filters.status !== 'ALL' && complaint.status !== filters.status) return false;
  if (filters.category !== 'ALL' && complaint.category !== filters.category) return false;
  if (filters.myDepartment && complaint.reporter_department !== department) return false;
  if (filters.zone === 'ALL') return true;
  if (filters.zone === 'LABS') return complaint.space_kind === 'LAB';
  if (filters.zone === 'CANTEENS') return complaint.space_kind === 'CANTEEN';
  if (filters.zone === 'BILL_BOTS') return complaint.space_kind === 'BILL_BOT';
  // Block filters apply to classrooms only: CAN-05 and BOT-… share the C/B
  // initials but have their own zones above.
  return complaint.space_kind === 'CLASSROOM' && complaint.space_code.startsWith(filters.zone.slice(-1));
}

export function CampusFeedPage() {
  const { token, user } = useAuthStore();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<ActiveFilters>(initialFilters);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [votingId, setVotingId] = useState<string | null>(null);
  const seenCommentIds = useRef(new Set<string>());
  const [filterOpen, setFilterOpen] = useState(false);
  const [, setClockTick] = useState(0);

  const loadComplaints = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const results = await api.listComplaints({
        zone: filters.zone,
        status: filters.status,
        category: filters.category,
        my_department: filters.myDepartment,
      });
      setComplaints(results);
      writeFeedCache(filters, results);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load the campus feed.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filters]);

  useEffect(() => {
    void loadComplaints();
  }, [loadComplaints]);

  // Paint the last snapshot instantly, then let the live fetch replace it.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const cached = readFeedCache(initialFilters);
    if (cached?.length) {
      setComplaints(cached);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token) return;
    return connectPortalSocket(token, (event) => {
      if ((event.type === 'COMPLAINT_CREATED' || event.type === 'COMPLAINT_UPDATED') && event.complaint) {
        const incoming = event.complaint;
        setComplaints((current) => {
          const exists = current.some((complaint) => complaint.id === incoming.id);
          if (!matchesFilters(incoming, filters, user?.department)) return current.filter((complaint) => complaint.id !== incoming.id);
          if (exists) return current.map((complaint) => complaint.id === incoming.id ? incoming : complaint);
          return [incoming, ...current];
        });
      }
      if (event.type === 'COMMENT_CREATED' && event.complaint_id && event.comment) {
        if (seenCommentIds.current.has(event.comment.id)) return;
        seenCommentIds.current.add(event.comment.id);
        setComplaints((current) => current.map((complaint) => complaint.id === event.complaint_id
          ? { ...complaint, comment_count: complaint.comment_count + 1 }
          : complaint));
      }
      if (event.type === 'TWIN_STATE_MUTATED' && event.space_code && event.visual_state) {
        setComplaints((current) => current.map((complaint) => complaint.space_code === event.space_code
          ? { ...complaint, twin_state: event.visual_state! }
          : complaint));
      }
    }, setConnected);
  }, [filters, token, user?.department]);

  const handleAffected = async (complaint: Complaint) => {
    setVotingId(complaint.id);
    setError('');
    try {
      const updated = await api.confirmAffected(complaint.id);
      setComplaints((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to confirm that you are affected.');
    } finally {
      setVotingId(null);
    }
  };

  const activeFilterCount = [filters.zone !== 'ALL', filters.status !== 'ALL', filters.category !== 'ALL', filters.myDepartment].filter(Boolean).length;

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <motion.header initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <p className="eyebrow">Live campus register</p>
            <span className={cx('flex items-center gap-1.5 text-[10px]', connected ? 'text-emerald-700' : 'text-stone')}>
              {connected ? <Wifi size={12} /> : <WifiOff size={12} />}{connected ? 'Live sync' : 'Reconnecting'}
            </span>
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Campus community feed</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-stone">Verified facility reports, shared observations, and live response status across campus.</p>
        </div>
        <Link to="/complaints/new" className="btn-primary self-start sm:self-auto"><FilePlus2 size={17} /> New complaint</Link>
      </motion.header>

      <section className="cloth-card mt-8 p-3 sm:p-4" aria-label="Feed filters">
        <div className="flex items-center gap-2 lg:hidden">
          <button type="button" className="btn-secondary flex-1" onClick={() => setFilterOpen((open) => !open)} aria-expanded={filterOpen}>
            <SlidersHorizontal size={16} /> Filters {activeFilterCount > 0 && <span className="mono rounded-full bg-ink px-2 py-0.5 text-[10px] text-white">{activeFilterCount}</span>}
          </button>
          <button type="button" className="icon-button" onClick={() => void loadComplaints(true)} disabled={refreshing} aria-label="Refresh feed"><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /></button>
        </div>

        <div className={cx('gap-3', filterOpen ? 'mt-3 grid' : 'hidden', 'lg:mt-0 lg:grid lg:grid-cols-[1fr_1fr_1fr_auto_auto]')}>
          <div>
            <label htmlFor="zone-filter" className="sr-only">Zone</label>
            <div className="relative">
              <Filter size={14} className="pointer-events-none absolute left-3.5 top-3.5 text-stone" />
              <select id="zone-filter" className="field appearance-none bg-white py-2.5 pl-9 pr-8 text-xs" value={filters.zone} onChange={(event) => setFilters((current) => ({ ...current, zone: event.target.value as ActiveFilters['zone'] }))}>
                {zones.map((zone) => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-3.5 text-stone" />
            </div>
          </div>
          <div>
            <label htmlFor="status-filter" className="sr-only">Status</label>
            <div className="relative">
              <select id="status-filter" className="field appearance-none bg-white py-2.5 pr-8 text-xs" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as ActiveFilters['status'] }))}>
                {statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-3.5 text-stone" />
            </div>
          </div>
          <div>
            <label htmlFor="category-filter" className="sr-only">Category</label>
            <div className="relative">
              <select id="category-filter" className="field appearance-none bg-white py-2.5 pr-8 text-xs" value={filters.category} onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}>
                <option value="ALL">All categories</option>
                {categories.map((category) => <option key={category} value={category}>{category.replaceAll('_', ' ')}</option>)}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-3.5 text-stone" />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFilters((current) => ({ ...current, myDepartment: !current.myDepartment }))}
            aria-pressed={filters.myDepartment}
            className={cx('flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-medium transition', filters.myDepartment ? 'border-ink/30 bg-ink text-white' : 'border-stitch bg-white text-stone hover:text-ink')}
          >
            {filters.myDepartment && <Check size={14} />} My department
          </button>
          <div className="flex gap-2">
            {activeFilterCount > 0 && (
              <button type="button" className="icon-button" onClick={() => setFilters(initialFilters)} aria-label="Clear filters" title="Clear filters"><X size={16} /></button>
            )}
            <button type="button" className="icon-button hidden lg:inline-flex" onClick={() => void loadComplaints(true)} disabled={refreshing} aria-label="Refresh feed"><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /></button>
          </div>
        </div>
      </section>

      <AnimatePresence>
        {error && (
          <motion.div role="alert" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <span className="flex-1">{error}</span>
            <button type="button" className="text-xs font-semibold underline underline-offset-4" onClick={() => void loadComplaints(true)}>Retry</button>
            <button type="button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-6 flex items-center justify-between">
        <p className="text-xs text-stone">{loading ? 'Loading verified reports…' : <><span className="mono font-semibold text-ink">{complaints.length}</span> report{complaints.length === 1 ? '' : 's'} in this view</>}</p>
        <p className="hidden text-[10px] text-stone sm:block">New and updated reports arrive automatically</p>
      </div>

      {loading ? (
        <div className="grid gap-5 pt-5 md:grid-cols-2 xl:grid-cols-3" role="status">
          <span className="sr-only">Loading campus complaints</span>
          {[0, 1, 2].map((item) => <div key={item} className="cloth-card h-80 animate-pulse bg-white/60" />)}
        </div>
      ) : complaints.length > 0 ? (
        <motion.div layout className="grid items-start gap-5 pt-5 md:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {complaints.map((complaint) => (
              <ComplaintCard key={complaint.id} complaint={complaint} voting={votingId === complaint.id} onAffected={handleAffected} onComments={(item) => navigate(`/complaints/${item.id}#comments`)} />
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <div className="cloth-card mt-5 flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-stitch bg-silk text-stone"><MessageSquareText size={25} strokeWidth={1.4} /></span>
          <h2 className="mt-5 text-lg font-semibold">No reports match this view</h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-stone">Try clearing a filter, or register a facilities issue that needs campus attention.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {activeFilterCount > 0 && <button type="button" className="btn-secondary" onClick={() => setFilters(initialFilters)}>Clear filters</button>}
            <Link to="/complaints/new" className="btn-primary"><FilePlus2 size={16} /> New complaint</Link>
          </div>
        </div>
      )}
    </div>
  );
}
