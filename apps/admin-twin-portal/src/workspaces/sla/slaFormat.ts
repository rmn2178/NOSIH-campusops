import type { SlaBasis, SlaBoardRow, SlaClockState, SlaResponseState } from '../../api/client';

/** The four-tier ladder the escalation engine walks, in order. */
export const ESCALATION_TIERS = [
  'Maintenance',
  'Incident Manager',
  'Facilities Admin',
  'Principal Office',
] as const;

export const PAUSE_REASONS = [
  { value: 'AWAITING_REPORTER', label: 'Awaiting reporter' },
  { value: 'AWAITING_STUDENT_RESPONSE', label: 'Awaiting student response' },
  { value: 'PARTS_UNAVAILABLE', label: 'Parts unavailable' },
  { value: 'EXTERNAL_VENDOR', label: 'External vendor on site' },
  { value: 'ACCESS_DENIED', label: 'Access denied on site' },
] as const;

export type PauseReason = (typeof PAUSE_REASONS)[number]['value'];

/** Roles that may stop or restart a clock. Procurement never does. */
export const SLA_CONTROL_ROLES = [
  'MAINTENANCE_TECHNICIAN',
  'INCIDENT_MANAGER',
  'FACILITIES_ADMIN',
  'SYSTEM_ADMIN',
  'DEPARTMENT_MANAGER',
] as const;

/** The desk runs 09:00-15:00, so one working day is six working hours. */
const WORKING_MINUTES_PER_DAY = 360;
/** Beyond a working week, hours read better than days. */
const WORKING_DAY_DISPLAY_LIMIT = 7;

export type BadgeTone = 'green' | 'red' | 'amber' | 'violet' | 'cyan' | 'neutral' | 'ink';

/**
 * Human target for a policy row: "30 min", "4 h", "48 working hours",
 * "5 working days". The raw minutes stay available as a tooltip.
 */
export function formatTargetMinutes(mins: number, basis: SlaBasis): string {
  if (!Number.isFinite(mins) || mins <= 0) return '—';
  if (mins < 60) return `${Math.round(mins)} min`;
  if (basis === 'CLOCK') {
    if (mins % 1440 === 0) return `${mins / 1440} d`;
    if (mins % 60 === 0) return `${mins / 60} h`;
    return `${Math.round(mins)} min`;
  }
  if (mins % WORKING_MINUTES_PER_DAY === 0 && mins / WORKING_MINUTES_PER_DAY <= WORKING_DAY_DISPLAY_LIMIT) {
    const days = mins / WORKING_MINUTES_PER_DAY;
    return `${days} working day${days === 1 ? '' : 's'}`;
  }
  if (mins % 60 === 0) return `${mins / 60} working hour${mins === 60 ? '' : 's'}`;
  return `${Math.round(mins)} working minutes`;
}

/** A live countdown. Under an hour it ticks in seconds, above it in hours. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** A duration read for humans, used for averages and elapsed time. */
export function formatDuration(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return '—';
  if (mins < 60) return `${Math.round(mins)} min`;
  const hours = mins / 60;
  if (hours < 24) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function priorityTone(code: string): BadgeTone {
  switch (code.toUpperCase()) {
    case 'P1': return 'red';
    case 'P2': return 'amber';
    case 'P3': return 'green';
    default: return 'neutral';
  }
}

export function priorityFill(code: string): string {
  switch (code.toUpperCase()) {
    case 'P1': return '#F87171';
    case 'P2': return '#F59E0B';
    case 'P3': return '#86EFAC';
    default: return '#A8A29E';
  }
}

export interface StateMeta {
  label: string;
  tone: BadgeTone;
  /** Bar and dot colour. */
  fill: string;
  text: string;
}

export function stateMeta(state: SlaClockState): StateMeta {
  switch (state) {
    case 'BREACHED': return { label: 'Breached', tone: 'red', fill: 'bg-red-500', text: 'text-red-700' };
    case 'WARNING': return { label: 'Warning', tone: 'amber', fill: 'bg-amber-500', text: 'text-amber-700' };
    case 'PAUSED': return { label: 'Paused', tone: 'violet', fill: 'bg-purple-500', text: 'text-purple-700' };
    case 'CLOSED': return { label: 'Closed', tone: 'neutral', fill: 'bg-stone', text: 'text-stone' };
    default: return { label: 'Healthy', tone: 'green', fill: 'bg-emerald-500', text: 'text-emerald-700' };
  }
}

export interface ResponseMeta {
  label: string;
  tone: BadgeTone;
  fill: string;
}

export function responseMeta(state: SlaResponseState): ResponseMeta {
  switch (state) {
    case 'MET': return { label: 'Answered', tone: 'green', fill: 'bg-emerald-500' };
    case 'BREACHED': return { label: 'Reply missed', tone: 'red', fill: 'bg-red-500' };
    case 'WARNING': return { label: 'Reply at risk', tone: 'amber', fill: 'bg-amber-500' };
    default: return { label: 'Awaiting reply', tone: 'neutral', fill: 'bg-stone' };
  }
}

/** Below 70 % is a red line, below 90 % is a warning, the rest is green. */
export function complianceTone(pct: number): { tone: BadgeTone; fill: string; text: string } {
  if (pct < 70) return { tone: 'red', fill: 'bg-red-500', text: 'text-red-700' };
  if (pct < 90) return { tone: 'amber', fill: 'bg-amber-500', text: 'text-amber-700' };
  return { tone: 'green', fill: 'bg-emerald-500', text: 'text-emerald-700' };
}

/**
 * The server value is the truth at load time. Between loads the console
 * projects it forward on the wall clock so the countdown visibly ticks.
 * Only 24x7 (CLOCK) policies move outside working hours; a working-hours
 * clock is left to the server.
 */
export function remainingSeconds(row: SlaBoardRow, loadedAt: number, now: number): number {
  const base = Math.max(0, row.resolution_remaining_mins) * 60;
  if (row.state === 'PAUSED' || row.state === 'CLOSED') return base;
  if (row.basis !== 'CLOCK') return base;
  const elapsed = Math.max(0, Math.floor((now - loadedAt) / 1000));
  return Math.max(0, base - elapsed);
}

export function isOverdue(row: SlaBoardRow): boolean {
  return row.resolution_remaining_mins <= 0 && row.resolution_progress_pct >= 100;
}

/** "2026-11-16" becomes "16 Nov". */
export function formatCalendarDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return day;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(parsed);
}

/** SAFETY_FIRE becomes "Safety fire". */
export function humanise(token?: string | null): string {
  if (!token) return '—';
  return token
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The notification log stores the target of every outbound escalation in
 * `payload_json`; the work order id is either `work_order_id` or the
 * `target_id` of a WORK_ORDER clock.
 */
export function notificationTargetsWorkOrder(payload: unknown, workOrderId: number): boolean {
  let record: Record<string, unknown> | null = null;
  if (typeof payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(payload);
      record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return false;
    }
  } else if (payload && typeof payload === 'object') {
    record = payload as Record<string, unknown>;
  }
  if (!record) return false;
  const direct = Number(record.work_order_id);
  if (Number.isFinite(direct) && direct > 0) return direct === workOrderId;
  const targetType = record.target_type;
  if (targetType !== undefined && String(targetType) !== 'WORK_ORDER') return false;
  const target = Number(record.target_id);
  return Number.isFinite(target) && target > 0 && target === workOrderId;
}

/** A short, human explanation for a rejected clock action. */
export function describeActionError(code?: string): string {
  switch (code) {
    case 'FORBIDDEN': return 'FORBIDDEN · your role cannot change this clock';
    case 'FORBIDDEN_DEPARTMENT_SCOPE': return 'FORBIDDEN_DEPARTMENT_SCOPE · that clock belongs to another department';
    case 'NOT_FOUND': return 'NOT_FOUND · that work order has no live clock';
    case 'INVALID_REASON': return 'INVALID_REASON · pick one of the five pause reasons';
    case 'ALREADY_PAUSED': return 'ALREADY_PAUSED · this clock is already stopped';
    case 'NOT_PAUSED': return 'NOT_PAUSED · this clock is already running';
    case undefined: return 'The clock action was rejected';
    default: return code;
  }
}
