import type { AcademicRole, ComplaintStatus, TwinState, Urgency } from '../api/client';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function roleLabel(role: AcademicRole): string {
  if (role === 'FACULTY_STAFF') return 'Faculty / Staff';
  return `${role.slice(-1)}${role === 'YEAR_1' ? 'st' : role === 'YEAR_2' ? 'nd' : 'rd'} Year`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function statusLabel(status: ComplaintStatus): string {
  return status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function urgencyLabel(urgency: Urgency): string {
  return urgency.charAt(0) + urgency.slice(1).toLowerCase();
}

export function twinLabel(state: TwinState): string {
  const labels: Record<TwinState, string> = {
    HEALTHY: 'Healthy',
    FAULTY: 'Major fault',
    DEGRADED: 'Manageable fault',
    BLOCKED_PARTS: 'Blocked on parts',
  };
  return labels[state];
}

const assetTypeShort: Record<string, string> = {
  CEILING_FAN: 'Fan',
  LED_LIGHT: 'Light',
  SMART_BOARD: 'Board',
  LAB_WORKSTATION: 'PC',
  CANTEEN_APPLIANCE: 'Appliance',
  BILL_BOT_MECHANISM: 'Bot',
};

/** Human label for a physical asset. Asset codes share a room prefix, so the
 * last two segments ("03-01") collide across a fan, a light and a board;
 * type + slot keeps every tile distinguishable. */
export function assetShortLabel(asset: { asset_type: string; asset_code: string; slot_index?: number | null }): string {
  const label = assetTypeShort[asset.asset_type]
    ?? asset.asset_type.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  const slot = asset.slot_index ?? Number(asset.asset_code.split('-').pop());
  return Number.isFinite(slot) ? `${label} ${String(slot).padStart(2, '0')}` : label;
}

export function slaLabel(complaint: { sla_breach_state?: string | null; sla_due_at?: string | null }): string {
  if (complaint.sla_breach_state === 'PAUSED') return 'SLA paused';
  if (complaint.sla_breach_state === 'BREACHED_100') return 'SLA breached';
  if (complaint.sla_breach_state === 'WARNING_75') return 'SLA warning';
  if (!complaint.sla_due_at) return 'SLA active';
  const remaining = new Date(complaint.sla_due_at).getTime() - Date.now();
  if (remaining <= 0) return 'SLA due';
  const minutes = Math.ceil(remaining / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
}

/** The area an officer covers: a block letter, the lab wing or the campus. */
export function areaLabel(area: string | null | undefined): string {
  if (!area) return 'Campus';
  if (area === 'LAB_WING') return 'Lab wing';
  if (area.length === 1) return `Block ${area}`;
  return area.replaceAll('_', ' ');
}
