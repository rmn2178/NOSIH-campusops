import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  DoorOpen,
  LockKeyhole,
  Search,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { api } from '../api/client';
import type { BookableRoom, BookingOutcome, FacultyBooking, RoomSlot } from '../api/client';
import { useAuthStore } from '../store/useAuthStore';
import { cx } from '../lib/format';

const PERIODS = [
  { number: 1, label: 'P1', time: '09:00' },
  { number: 2, label: 'P2', time: '09:50' },
  { number: 3, label: 'P3', time: '10:55' },
  { number: 4, label: 'P4', time: '11:45' },
  { number: 5, label: 'P5', time: '13:20' },
  { number: 6, label: 'P6', time: '14:10' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The next five teaching days, Monday first, in the campus timezone. */
function teachingDays(count = 5): string[] {
  const days: string[] = [];
  const cursor = new Date();
  while (days.length < count) {
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6) days.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function dayLabel(date: string): { name: string; day: number } {
  const parsed = new Date(`${date}T00:00:00`);
  return { name: DAY_NAMES[parsed.getDay()], day: parsed.getDate() };
}

function formatWindow(start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${formatter.format(new Date(start))} – ${formatter.format(new Date(end))}`;
}

function messageFor(result: BookingOutcome): string {
  switch (result.error) {
    case 'DOUBLE_BOOKED':
      return 'That window already has an active booking.';
    case 'ROOM_IN_USE':
      return 'A scheduled class or exam occupies that window.';
    case 'CAPACITY_EXCEEDED':
      return `The class has ${result.student_strength} students and this room seats ${result.room_capacity}.`;
    case 'ROOM_NOT_HEALTHY':
      return 'This room is not healthy, so it cannot be booked until it is restored.';
    case 'CLASS_NOT_FOUND':
      return 'That class code does not exist.';
    case 'INVALID_WINDOW':
      return result.reason === 'MAX_12_HOURS' ? 'Bookings are limited to 12 hours.' : 'The booking window is invalid.';
    case 'FORBIDDEN':
      return 'Your role cannot create bookings.';
    default:
      return result.error ? result.error.replaceAll('_', ' ').toLowerCase() : 'The booking could not be created.';
  }
}

function slotTone(slot: RoomSlot): string {
  if (slot.state === 'CLASS') return 'border-stitch bg-silk text-ink';
  if (slot.state === 'EXAM') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (slot.state === 'BOOKING') return 'border-cyan-200 bg-cyan-50 text-cyan-900';
  return 'border-emerald-100 bg-emerald-50/50 text-emerald-900 hover:border-emerald-300';
}

export function RoomBookingPage() {
  const { user } = useAuthStore();
  const canBook = Boolean(user && user.role !== 'STUDENT');
  const days = useMemo(() => teachingDays(), []);
  const [date, setDate] = useState(days[0]);
  const [rooms, setRooms] = useState<BookableRoom[]>([]);
  const [mine, setMine] = useState<FacultyBooking[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [purpose, setPurpose] = useState('');
  const [classCode, setClassCode] = useState(user?.class_code ?? '');
  const [startPeriod, setStartPeriod] = useState<number | null>(null);
  const [endPeriod, setEndPeriod] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BookingOutcome | null>(null);
  const [success, setSuccess] = useState('');
  const [requestKey, setRequestKey] = useState<string | null>(null);

  const room = rooms.find((item) => item.room_code === selected);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [available, own] = await Promise.all([api.bookings.rooms(date), api.bookings.mine()]);
      setRooms(available);
      setMine(own);
      setSelected((current) => (available.some((item) => item.room_code === current) ? current : ''));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load the room calendar');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  // The profile arrives after the first paint, so fill the class once it lands.
  useEffect(() => {
    setClassCode((current) => current || user?.class_code || '');
  }, [user?.class_code]);

  useEffect(() => {
    setStartPeriod(null);
    setEndPeriod(null);
    setResult(null);
    setSuccess('');
  }, [date, selected]);

  useEffect(() => {
    setRequestKey(null);
  }, [date, selected, startPeriod, endPeriod, purpose, classCode]);

  const visibleRooms = useMemo(() => {
    const query = search.trim().toUpperCase();
    const filtered = query ? rooms.filter((item) => item.room_code.includes(query) || item.block.toUpperCase().includes(query)) : rooms;
    return filtered
      .map((item) => ({
        room: item,
        free: item.slots.filter((slot) => slot.state === 'FREE').length,
      }))
      .sort((a, b) => b.free - a.free || a.room.room_code.localeCompare(b.room.room_code));
  }, [rooms, search]);

  const pickPeriod = (period: number) => {
    setResult(null);
    setSuccess('');
    if (startPeriod === null) {
      setStartPeriod(period);
      setEndPeriod(period);
      return;
    }
    if (period < startPeriod) {
      setEndPeriod(startPeriod);
      setStartPeriod(period);
      return;
    }
    setEndPeriod(period);
  };

  const window_ = useMemo(() => {
    if (!room || startPeriod === null || endPeriod === null) return null;
    const start = room.slots.find((slot) => slot.period_number === startPeriod);
    const end = room.slots.find((slot) => slot.period_number === endPeriod);
    if (!start || !end) return null;
    return { startsAt: start.starts_at, endsAt: end.ends_at };
  }, [room, startPeriod, endPeriod]);

  const book = useCallback(
    async (spaceCode: string, key: string) => {
      if (!window_) return;
      setBusy(true);
      setError('');
      setSuccess('');
      try {
        const response = await api.bookings.create({
          spaceCode,
          startsAt: window_.startsAt,
          endsAt: window_.endsAt,
          purpose: purpose.trim() || 'Faculty room booking',
          classCode: classCode.trim() || null,
          requestKey: key,
        });
        setResult(response);
        if (!response.success) {
          setError(messageFor(response));
          return;
        }
        setSuccess(
          `Booked ${response.space_code} · ${formatWindow(response.starts_at ?? window_.startsAt, response.ends_at ?? window_.endsAt)}${
            response.idempotent ? ' · retry acknowledged' : ''
          }`,
        );
        setRequestKey(null);
        setPurpose('');
        await load();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'The booking could not be created');
      } finally {
        setBusy(false);
      }
    },
    [classCode, load, purpose, window_],
  );

  const submit = () => {
    if (!room || !window_) return;
    const key = requestKey ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    setRequestKey(key);
    void book(room.room_code, key);
  };

  const cancel = async (booking: FacultyBooking) => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const response = await api.bookings.cancel(Number(booking.id));
      if (!response.success) {
        setError(messageFor(response));
        return;
      }
      setSuccess(`Cancelled ${booking.space_code} · ${booking.purpose}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The booking could not be cancelled');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <motion.header initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">Faculty services</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Reserve a room</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-stone">
            Live availability from the campus timetable, the exam calendar and the booking register. The server re-checks
            every class, exam, booking and capacity rule before it confirms a window.
          </p>
        </div>
        <Link to="/feed" className="btn-secondary self-start sm:self-auto">Back to the feed</Link>
      </motion.header>

      <section className="cloth-card mt-8 p-3 sm:p-4" aria-label="Teaching days">
        <div className="flex flex-wrap gap-1.5">
          {days.map((day) => {
            const label = dayLabel(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => setDate(day)}
                aria-pressed={date === day}
                className={cx(
                  'flex min-w-[74px] flex-col items-center rounded-xl border px-3 py-2 text-xs transition',
                  date === day ? 'border-ink bg-ink text-white' : 'border-stitch bg-white text-stone hover:border-stone/50 hover:text-ink',
                )}
              >
                <span className="text-[10px] uppercase tracking-wider opacity-80">{label.name}</span>
                <span className="mono mt-0.5 text-sm font-semibold">{label.day}</span>
              </button>
            );
          })}
          <span className="ml-auto flex items-center gap-1.5 self-center text-[10px] text-stone">
            <LockKeyhole size={12} /> Times are IST periods
          </span>
        </div>
      </section>

      {error && (
        <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section className="cloth-card p-4" aria-label="Rooms">
          <div className="flex items-center gap-2">
            <DoorOpen size={16} className="text-stone" />
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em]">Healthy rooms</h2>
            <span className="mono ml-auto rounded-full bg-silk px-2 py-0.5 text-[10px] text-stone">{rooms.length}</span>
          </div>

          <div className="relative mt-3">
            <Search size={14} className="pointer-events-none absolute left-3 top-3 text-stone" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find B4-03 or block B"
              aria-label="Search rooms"
              className="field h-9 py-0 pl-9 text-xs"
            />
          </div>

          <div className="no-scrollbar mt-3 max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
            {loading && <p className="px-1 py-6 text-center text-xs text-stone">Reading the room calendar…</p>}
            {!loading && visibleRooms.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-stone">No healthy room matches that search.</p>
            )}
            {visibleRooms.map(({ room: item, free }) => (
              <button
                key={item.room_code}
                type="button"
                onClick={() => setSelected(item.room_code)}
                aria-pressed={selected === item.room_code}
                className={cx(
                  'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition',
                  selected === item.room_code ? 'border-ink bg-ink text-white' : 'border-stitch bg-white text-ink hover:border-stone/50',
                )}
              >
                <span className="mono text-sm font-semibold">{item.room_code}</span>
                <span className={cx('text-[10px]', selected === item.room_code ? 'text-white/70' : 'text-stone')}>
                  Block {item.block} · Floor {item.floor_number}
                </span>
                <span className="ml-auto flex items-center gap-1 text-[10px]">
                  <UsersRound size={12} />
                  {item.capacity}
                </span>
                <span className={cx('mono rounded-full px-2 py-0.5 text-[10px]', selected === item.room_code ? 'bg-white/15' : free > 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-silk text-stone')}>
                  {free} free
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="cloth-card p-4" aria-label="Room calendar">
          {!room ? (
            <div className="flex min-h-[18rem] flex-col items-center justify-center px-6 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-stitch bg-silk text-stone"><CalendarDays size={25} strokeWidth={1.4} /></span>
              <h2 className="mt-5 text-lg font-semibold">Pick a room to see its day</h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-stone">
                Every period is checked against live classes, exams and other bookings. Faulted rooms never appear here.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="mono text-lg font-semibold">{room.room_code}</h2>
                <span className="rounded-full border border-stitch bg-white px-2.5 py-1 text-[10px] text-stone">Block {room.block} · Floor {room.floor_number}</span>
                <span className="rounded-full border border-stitch bg-white px-2.5 py-1 text-[10px] text-stone">{room.capacity} seats</span>
                <button type="button" onClick={() => setSelected('')} className="ml-auto text-[10px] text-stone underline underline-offset-4 hover:text-ink">Change room</button>
              </div>

              <div className="mt-4 grid gap-1.5 sm:grid-cols-3 xl:grid-cols-6">
                {PERIODS.map((period) => {
                  const slot = room.slots.find((item) => item.period_number === period.number);
                  const picked = slot ? startPeriod !== null && period.number >= startPeriod && period.number <= (endPeriod ?? startPeriod) : false;
                  return (
                    <button
                      key={period.number}
                      type="button"
                      disabled={!slot || slot.state !== 'FREE'}
                      onClick={() => pickPeriod(period.number)}
                      title={slot ? `${slot.label ?? 'Free'} · ${slot.owner ?? slot.state}` : 'Free'}
                      className={cx(
                        'rounded-xl border p-3 text-left transition disabled:cursor-default',
                        slot ? slotTone(slot) : 'border-stitch bg-white text-stone',
                        picked && 'ring-2 ring-ink ring-offset-1',
                        !slot || slot.state !== 'FREE' ? 'opacity-95' : 'hover:border-emerald-400',
                      )}
                    >
                      <p className="mono text-[11px] font-semibold">{period.label}</p>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-4">
                        {slot ? (slot.state === 'FREE' ? 'Free' : slot.label) : '—'}
                      </p>
                      <p className="mono mt-1.5 text-[9px] opacity-70">{period.time}</p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <label className="field-label">
                  Purpose
                  <input
                    value={purpose}
                    onChange={(event) => setPurpose(event.target.value)}
                    maxLength={80}
                    placeholder="Capstone review"
                    disabled={!canBook}
                    className="field mt-1 py-2.5 text-sm"
                  />
                </label>
                <label className="field-label">
                  Class (optional)
                  <input
                    value={classCode}
                    onChange={(event) => setClassCode(event.target.value)}
                    maxLength={20}
                    placeholder="AIDS-Y1-A"
                    disabled={!canBook}
                    className="field mt-1 py-2.5 text-sm"
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" onClick={submit} disabled={busy || !window_ || !canBook} className="btn-primary">
                  {busy ? 'Checking availability…' : window_ ? `Book ${room.room_code} · ${formatWindow(window_.startsAt, window_.endsAt)}` : 'Select a free period'}
                </button>
                <span className="text-[10px] text-stone">A request key makes a retried booking land on the same record.</span>
              </div>

              {!canBook && (
                <p className="mt-4 rounded-xl border border-stitch bg-silk px-3 py-2.5 text-[11px] text-stone">
                  Your role can read the room calendar, but booking a room is for faculty and staff.
                </p>
              )}

              {result && !result.success && result.conflicts && result.conflicts.length > 0 && (
                <ul className="mt-4 space-y-1.5">
                  {result.conflicts.map((conflict, index) => (
                    <li key={`${conflict.kind}-${index}`} className="rounded-lg border border-stitch bg-silk px-3 py-2 text-[11px]">
                      <span className="font-semibold">{conflict.kind}</span> · {conflict.label}
                      {conflict.owner ? ` · ${conflict.owner}` : ''}
                      {conflict.student_strength ? ` · ${conflict.student_strength} students` : ''}
                    </li>
                  ))}
                </ul>
              )}

              {result && !result.success && result.alternatives && result.alternatives.length > 0 && (
                <div className="mt-4">
                  <p className="field-label">Same window, other healthy rooms</p>
                  <div className="flex flex-wrap gap-2">
                    {result.alternatives.map((alternative) => (
                      <button
                        key={alternative.room_code}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto
                            ? crypto.randomUUID()
                            : `${Date.now().toString(36)}-alt`;
                          void book(alternative.room_code, key);
                        }}
                        className="btn-secondary px-3 py-2 text-xs"
                      >
                        Book {alternative.room_code} · {alternative.capacity} seats
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {success && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-900">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
                  <p>{success}</p>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <section className="cloth-card mt-5 p-4" aria-label="Your bookings">
        <div className="flex items-center gap-2">
          <CalendarCheck size={16} className="text-stone" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em]">Your bookings</h2>
          <span className="mono ml-auto rounded-full bg-silk px-2 py-0.5 text-[10px] text-stone">{mine.length}</span>
        </div>

        {mine.length === 0 ? (
          <p className="mt-3 text-xs text-stone">You have no upcoming bookings. The timetable still owns every scheduled class.</p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {mine.map((booking) => (
              <li key={booking.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-stitch bg-white px-3 py-2.5 text-xs">
                <span className="mono font-semibold">{booking.space_code}</span>
                <span className="mono text-[10px] text-stone">{formatWindow(booking.starts_at, booking.ends_at)}</span>
                <span className="min-w-0 flex-1 truncate">{booking.purpose}</span>
                {booking.class_code && <span className="mono text-[10px] text-stone">{booking.class_code}</span>}
                <button
                  type="button"
                  onClick={() => void cancel(booking)}
                  disabled={busy}
                  className="flex items-center gap-1 text-[10px] font-semibold text-red-700 disabled:opacity-50"
                >
                  <Trash2 size={12} /> Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
