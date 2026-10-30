import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, CalendarDays, CheckCircle2, Clock3, LockKeyhole, UsersRound } from 'lucide-react';
import { api } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { usePortalStore } from '../../store/portalStore';
import type { Booking, BookingResult, DayCode, RoomConflict, RoomOccupancy, SpaceKind, VisualState } from '../../types';
import { Badge, Button, ErrorBanner, Spinner, cx } from '../ui';

const DAYS: Array<{ code: DayCode; label: string }> = [
  { code: 'MON', label: 'Mon' },
  { code: 'TUE', label: 'Tue' },
  { code: 'WED', label: 'Wed' },
  { code: 'THU', label: 'Thu' },
  { code: 'FRI', label: 'Fri' },
];

const PERIODS = [
  { number: 1, start: '09:00', end: '09:50' },
  { number: 2, start: '09:50', end: '10:40' },
  { number: 3, start: '10:55', end: '11:45' },
  { number: 4, start: '11:45', end: '12:35' },
  { number: 5, start: '13:20', end: '14:10' },
  { number: 6, start: '14:10', end: '15:00' },
];

const BOOKING_ROLES = ['DEPARTMENT_MANAGER', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'SYSTEM_ADMIN'];

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function dateFor(day: DayCode): string {
  const want = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5 }[day];
  const now = new Date();
  const delta = (want - now.getDay() + 7) % 7;
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

function isoAt(date: string, time: string): string {
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}

function formatWindow(start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${formatter.format(new Date(start))}–${formatter.format(new Date(end))}`;
}

function messageFor(result: BookingResult): string {
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

function conflictTone(kind: RoomConflict['kind']) {
  if (kind === 'EXAM') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (kind === 'BOOKING') return 'border-cyan-200 bg-cyan-50 text-cyan-900';
  return 'border-stitch bg-silk text-ink';
}

export function BookingPanel({
  code,
  kind,
  visualState,
  onChanged,
}: {
  code: string;
  kind: SpaceKind;
  visualState: VisualState;
  onChanged: () => void;
}) {
  const { user } = useAuthStore();
  const { twinRevision } = usePortalStore();
  const canBook = Boolean(user && BOOKING_ROLES.includes(user.role));

  const [day, setDay] = useState<DayCode>('MON');
  const [occupancy, setOccupancy] = useState<RoomOccupancy | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startPeriod, setStartPeriod] = useState(1);
  const [endPeriod, setEndPeriod] = useState(1);
  const [purpose, setPurpose] = useState('');
  const [classCode, setClassCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState<string | null>(null);

  const date = useMemo(() => dateFor(day), [day]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const from = isoAt(date, '09:00');
      const to = isoAt(date, '15:00');
      const [roomOccupancy, allBookings] = await Promise.all([
        api.bookings.occupancy(code, from, to),
        api.bookings.list(),
      ]);
      setOccupancy(roomOccupancy);
      setBookings(
        allBookings.filter(
          (booking) => booking.space_code.toUpperCase() === code.toUpperCase() && booking.status === 'ACTIVE',
        ),
      );
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load room bookings');
    } finally {
      setLoading(false);
    }
  }, [code, date]);

  useEffect(() => {
    void load();
  }, [load, twinRevision]);

  useEffect(() => {
    setRequestKey(null);
  }, [code, day, startPeriod, endPeriod, purpose, classCode]);

  useEffect(() => {
    setResult(null);
    setError(null);
    setSuccess(null);
  }, [code, day]);

  const conflictFor = useCallback(
    (period: number): RoomConflict | undefined => {
      if (!occupancy) return undefined;
      const start = new Date(isoAt(date, PERIODS[period - 1].start)).getTime();
      const end = new Date(isoAt(date, PERIODS[period - 1].end)).getTime();
      return occupancy.conflicts.find(
        (conflict) => new Date(conflict.starts_at).getTime() < end && new Date(conflict.ends_at).getTime() > start,
      );
    },
    [date, occupancy],
  );

  const book = useCallback(
    async (spaceCode: string, key: string) => {
      setBusy(true);
      setError(null);
      setSuccess(null);
      try {
        const response = await api.bookings.create({
          spaceCode,
          startsAt: isoAt(date, PERIODS[startPeriod - 1].start),
          endsAt: isoAt(date, PERIODS[endPeriod - 1].end),
          purpose: purpose.trim() || 'Booked room',
          classCode: classCode.trim() || null,
          requestKey: key,
        });
        setResult(response);
        if (!response.success) {
          setError(messageFor(response));
          return;
        }
        setSuccess(
          `Booked ${response.space_code} · ${DAYS.find((item) => item.code === day)?.label} P${startPeriod}–P${endPeriod}${
            response.idempotent ? ' · retry acknowledged' : ''
          }`,
        );
        setRequestKey(null);
        setPurpose('');
        onChanged();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'The booking could not be created');
      } finally {
        setBusy(false);
      }
    },
    [classCode, date, day, endPeriod, onChanged, purpose, startPeriod],
  );

  const submit = () => {
    const key = requestKey ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    setRequestKey(key);
    void book(code, key);
  };

  const cancel = async (booking: Booking) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.bookings.cancel(booking.id);
      setSuccess(`Cancelled ${booking.purpose}`);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The booking could not be cancelled');
    } finally {
      setBusy(false);
    }
  };

  if (kind === 'CANTEEN' || kind === 'BILL_BOT') return null;

  return (
    <section className="rounded-2xl border border-stitch bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4" />
          <h3 className="text-xs font-semibold uppercase tracking-[.12em]">Room calendar & bookings</h3>
        </div>
        <div className="flex items-center gap-2">
          {occupancy && <Badge tone="neutral">{occupancy.capacity} seats</Badge>}
          {visualState !== 'HEALTHY' && <Badge tone="red">{visualState.replaceAll('_', ' ')}</Badge>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {DAYS.map((item) => (
          <button
            key={item.code}
            type="button"
            onClick={() => setDay(item.code)}
            className={cx(
              'rounded-md px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition',
              day === item.code ? 'bg-obsidian text-white' : 'bg-silk text-stone hover:text-ink',
            )}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-[10px] text-stone">
          <Clock3 className="h-3 w-3" /> IST periods
        </span>
      </div>

      {loading && !occupancy ? (
        <Spinner label="Reading the room calendar" />
      ) : loadError ? (
        <ErrorBanner message={loadError} onRetry={() => void load()} />
      ) : (
        <>
          <div className="mt-3 grid grid-cols-6 gap-1.5">
            {PERIODS.map((period) => {
              const conflict = conflictFor(period.number);
              const selected = period.number >= startPeriod && period.number <= endPeriod;
              return (
                <button
                  key={period.number}
                  type="button"
                  onClick={() => {
                    setStartPeriod(period.number);
                    setEndPeriod((current) => (current < period.number ? period.number : current));
                  }}
                  title={conflict ? `${conflict.label} · ${conflict.owner ?? conflict.kind}` : 'Free'}
                  className={cx(
                    'min-w-0 rounded-lg border p-2 text-left transition',
                    conflict ? conflictTone(conflict.kind) : 'border-emerald-100 bg-emerald-50/40 text-emerald-900 hover:border-emerald-300',
                    selected && 'ring-2 ring-obsidian ring-offset-1',
                  )}
                >
                  <p className="mono text-[10px] font-semibold">P{period.number}</p>
                  <p className="mt-1 truncate text-[9px]">{conflict ? conflict.label : 'Free'}</p>
                  <p className="mono mt-1 text-[8px] opacity-70">{period.start}</p>
                </button>
              );
            })}
          </div>

          <p className="mt-2 text-[10px] text-stone">
            Classes and exams are blocked by the backend, not just hidden in this grid.
          </p>

          {canBook ? (
            <form
              className="mt-3 rounded-xl border border-stitch bg-silk/50 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-stone">
                  Purpose
                  <input
                    value={purpose}
                    onChange={(event) => setPurpose(event.target.value)}
                    maxLength={80}
                    placeholder="Department review"
                    className="mt-1 h-9 w-full rounded-lg border border-stitch bg-white px-3 text-xs font-normal normal-case tracking-normal text-ink outline-none focus:border-stone-400"
                  />
                </label>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-stone">
                  Class (optional)
                  <input
                    value={classCode}
                    onChange={(event) => setClassCode(event.target.value)}
                    maxLength={20}
                    placeholder="CS-2A"
                    className="mt-1 h-9 w-full rounded-lg border border-stitch bg-white px-3 text-xs font-normal normal-case tracking-normal text-ink outline-none focus:border-stone-400"
                  />
                </label>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-stone">
                  From period
                  <select
                    value={startPeriod}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setStartPeriod(next);
                      setEndPeriod((current) => (current < next ? next : current));
                    }}
                    className="mt-1 h-9 w-full rounded-lg border border-stitch bg-white px-2 text-xs font-normal normal-case tracking-normal text-ink"
                  >
                    {PERIODS.map((period) => (
                      <option key={period.number} value={period.number}>
                        P{period.number} · {period.start}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-stone">
                  To period
                  <select
                    value={endPeriod}
                    onChange={(event) => setEndPeriod(Number(event.target.value))}
                    className="mt-1 h-9 w-full rounded-lg border border-stitch bg-white px-2 text-xs font-normal normal-case tracking-normal text-ink"
                  >
                    {PERIODS.filter((period) => period.number >= startPeriod).map((period) => (
                      <option key={period.number} value={period.number}>
                        P{period.number} · {period.end}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Checking availability…' : 'Book this window'}
                </Button>
                <span className="flex items-center gap-1 text-[10px] text-stone">
                  <LockKeyhole className="h-3 w-3" /> The server re-checks class, exam, booking and capacity gates.
                </span>
              </div>
            </form>
          ) : (
            <p className="mt-3 rounded-lg border border-stitch bg-silk p-3 text-[11px] text-stone">
              Your role can view the room calendar but not create bookings.
            </p>
          )}

          {error && (
            <div className="mt-3 space-y-2">
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] leading-4 text-red-900">
                <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>{error}</p>
              </div>
              {result?.conflicts && result.conflicts.length > 0 && (
                <ul className="space-y-1">
                  {result.conflicts.map((conflict, index) => (
                    <li
                      key={`${conflict.kind}-${index}`}
                      className={cx('rounded-md border px-2 py-1.5 text-[10px]', conflictTone(conflict.kind))}
                    >
                      <span className="font-semibold">{conflict.kind}</span> · {conflict.label}
                      {conflict.owner ? ` · ${conflict.owner}` : ''}
                      <span className="mono ml-1 opacity-70">{formatWindow(conflict.starts_at, conflict.ends_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {result?.alternatives && result.alternatives.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-stone">
                    Same window, other healthy rooms
                  </p>
                  <div className="flex flex-wrap gap-1.5">
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
                        className="rounded-md border border-stitch bg-white px-2.5 py-1.5 text-[10px] font-medium transition hover:border-stone-400"
                      >
                        Book {alternative.room_code} · {alternative.capacity} seats
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {success && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>{success}</p>
            </div>
          )}

          <div className="mt-4 border-t border-stitch pt-3">
            <div className="mb-2 flex items-center gap-2">
              <UsersRound className="h-3.5 w-3.5" />
              <p className="text-[10px] font-semibold uppercase tracking-wider text-stone">
                Active bookings for {code}
              </p>
              <Badge tone="neutral" className="ml-auto">{bookings.length}</Badge>
            </div>
            {bookings.length === 0 ? (
              <p className="text-[11px] text-stone">No active bookings. The timetable still owns every scheduled class.</p>
            ) : (
              <ul className="space-y-1.5">
                {bookings.map((booking) => (
                  <li key={booking.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-stitch bg-white px-2.5 py-2 text-[11px]">
                    <span className="mono text-[10px] font-semibold">{formatWindow(booking.starts_at, booking.ends_at)}</span>
                    <span className="min-w-0 flex-1 truncate">{booking.purpose}</span>
                    {booking.class_code && <span className="mono text-[10px] text-stone">{booking.class_code}</span>}
                    <span className="text-[10px] text-stone">{booking.booked_by_name ?? 'Staff'}</span>
                    {canBook && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void cancel(booking)}
                        className="text-red-700"
                      >
                        Cancel
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
