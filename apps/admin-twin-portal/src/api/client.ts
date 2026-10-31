import {
  rpc,
  signIn,
  signOut,
  supabase,
} from '@nosih/supabase-client';
import type {
  ApprovalPreflight,
  AssetHistory,
  AuditEntry,
  AuditVerification,
  Booking,
  BookingResult,
  CampusClock,
  Complaint,
  Incident,
  InventoryItem,
  LoginResponse,
  ModerationItem,
  NotificationLog,
  PartRequest,
  PartsPreflightResult,
  PurchaseRequest,
  ResourceLock,
  ResourceType,
  Role,
  RoomConflict,
  RoomConflictResult,
  RoomOccupancy,
  ScenarioResult,
  ScenarioRun,
  PulseInjectResult,
  PulseStatus,
  ScenarioSummary,
  SlaClock,
  SpaceDetail,
  StaffProfile,
  StaffRankingResult,
  TimetableSlot,
  TimetableValidation,
  TwinOverview,
  TwinSpace,
  User,
  WorkforceSummary,
  WorkOrder,
} from '../types';

// ---------------------------------------------------------------------------
// SLA read models.
//
// The SLA engine and its read models live in the database; the admin portal
// only reads them. These interfaces mirror `rpc_sla_matrix`, `rpc_sla_board`
// and `rpc_sla_compliance` exactly, so the console never guesses a shape.
// ---------------------------------------------------------------------------

export type SlaBasis = 'CLOCK' | 'WORKING';
export type SlaClockState = 'HEALTHY' | 'WARNING' | 'BREACHED' | 'PAUSED' | 'CLOSED';
export type SlaResponseState = 'PENDING' | 'MET' | 'WARNING' | 'BREACHED';

export interface SlaPolicy {
  priority_code: string;
  priority_label: string;
  service_name: string;
  /** null means the policy covers every category for the priority. */
  category: string | null;
  response_target_mins: number;
  resolution_target_mins: number;
  response_hours: number;
  resolution_hours: number;
  resolution_days: number;
  is_24x7: boolean;
  basis: SlaBasis;
  description: string;
}

export interface SlaCalendarDay {
  day_date: string;
  is_working_day: boolean;
  label: string | null;
  open_minute: number | null;
  close_minute: number | null;
  note: string | null;
  opens_at: string | null;
  closes_at: string | null;
}

export interface SlaWorkingHours {
  opens_at: string;
  closes_at: string;
  timezone: string;
  days: string;
  note: string;
}

export interface SlaMatrix {
  policies: SlaPolicy[];
  calendar: SlaCalendarDay[];
  working_hours: SlaWorkingHours;
}

export interface SlaOfficer {
  staff_code: string;
  full_name: string;
  primary_skill: string;
  skill_proficiency: number;
  area: string;
  assigned_jobs: number;
  max_jobs: number;
  hourly_cost_inr: number;
}

export interface SlaBoardRow {
  clock_id: number;
  work_order_id: number;
  work_order_number: string;
  ticket_number: string | null;
  title: string | null;
  space_code: string;
  category: string | null;
  urgency: string | null;
  department_code: string;
  priority_code: string;
  priority_label: string;
  service_name: string;
  policy_note: string | null;
  is_24x7: boolean;
  basis: SlaBasis;
  state: SlaClockState;
  breach_state: string;
  response_state: SlaResponseState;
  first_response_at: string | null;
  response_target_mins: number;
  response_elapsed_mins: number;
  response_remaining_mins: number;
  response_progress_pct: number;
  resolution_target_mins: number;
  resolution_elapsed_mins: number;
  resolution_remaining_mins: number;
  resolution_progress_pct: number;
  pause_reason: string | null;
  last_milestone: string | null;
  escalation_tier: number;
  escalated_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  officer: SlaOfficer | null;
  officer_email: string | null;
  head_of_department: string | null;
  work_order_status: string | null;
}

export interface SlaBoardSummary {
  total: number;
  healthy: number;
  warning: number;
  breached: number;
  paused: number;
  closed: number;
  response_pending: number;
}

export interface SlaBoard {
  rows: SlaBoardRow[];
  summary: SlaBoardSummary;
}

export interface SlaComplianceTotals {
  requests: number;
  closed: number;
  met: number;
  missed: number;
  open: number;
  open_breached: number;
  compliance_pct: number;
  responded: number;
  response_missed: number;
  response_compliance_pct: number;
  avg_resolution_mins: number;
}

export interface SlaDepartmentCompliance {
  department_code: string;
  services: string[];
  requests: number;
  closed: number;
  met: number;
  breached: number;
  open: number;
  compliance_pct: number;
  avg_resolution_mins: number;
}

export interface SlaPriorityCompliance {
  priority_code: string;
  requests: number;
  closed: number;
  met: number;
  breached: number;
  compliance_pct: number;
}

export interface SlaServiceCompliance {
  service_name: string;
  requests: number;
  closed: number;
  met: number;
  compliance_pct: number;
}

export interface SlaCompliance {
  window_days: number;
  window_basis: string;
  totals: SlaComplianceTotals;
  by_department: SlaDepartmentCompliance[];
  by_priority: SlaPriorityCompliance[];
  by_service: SlaServiceCompliance[];
}

export type SlaComplianceReport = SlaCompliance;

/** Outcome of a pause or resume request; the RPC resolves the actor itself. */
export interface SlaClockAction {
  success: boolean;
  error?: string;
}

export const TOKEN_STORAGE_KEY = 'nosih.admin.access_token';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Raw = Record<string, unknown>;

let cachedProfile: { email: string; full_name: string; role: Role; staff_code: string | null } | null = null;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function mapRole(role: string): Role {
  return role === 'MAINTENANCE' ? 'MAINTENANCE_TECHNICIAN' : (role as Role);
}

async function loadProfile() {
  if (cachedProfile) return cachedProfile;
  const { data, error } = await supabase.rpc('rpc_my_profile');
  if (error || !data) throw new ApiError(error?.message ?? 'Session expired', 401, null);
  const raw = data as Raw;
  cachedProfile = {
    email: str(raw.email),
    full_name: str(raw.full_name),
    role: mapRole(str(raw.role)),
    staff_code: raw.staff_code ? str(raw.staff_code) : null,
  };
  return cachedProfile;
}

let meInFlight: Promise<User> | null = null;

function loadMe(): Promise<User> {
  if (!meInFlight) {
    meInFlight = (async () => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new ApiError('Unauthorized', 401, null);
      const { data, error } = await supabase.rpc('rpc_my_profile');
      if (error || !data) throw new ApiError(error?.message ?? 'Profile not found', 401, null);
      const raw = data as Raw;
      cachedProfile = {
        email: str(raw.email),
        full_name: str(raw.full_name),
        role: mapRole(str(raw.role)),
        staff_code: raw.staff_code ? str(raw.staff_code) : null,
      };
      return {
        id: str(raw.id),
        email: str(raw.email),
        full_name: str(raw.full_name),
        role: cachedProfile.role,
        department_code: raw.department_code ? str(raw.department_code) : undefined,
        staff_code: cachedProfile.staff_code ?? undefined,
      };
    })().finally(() => {
      meInFlight = null;
    });
  }
  return meInFlight;
}

function mapTwinSpace(raw: Raw): TwinSpace {
  return {
    code: str(raw.code),
    kind: (raw.kind as TwinSpace['kind']) ?? 'CLASSROOM',
    name: str(raw.name),
    block: raw.block ? str(raw.block) : undefined,
    floor: raw.floor === null || raw.floor === undefined ? undefined : num(raw.floor),
    visual_state: (raw.visual_state as TwinSpace['visual_state']) ?? 'HEALTHY',
    is_occupied_now: Boolean(raw.is_occupied_now),
    is_home_class_in_lab: Boolean(raw.is_home_class_in_lab),
    current_class_code: raw.current_class_code ? str(raw.current_class_code) : null,
    current_student_count: raw.current_student_count === null || raw.current_student_count === undefined ? null : num(raw.current_student_count),
    room_capacity: raw.room_capacity === null || raw.room_capacity === undefined ? undefined : num(raw.room_capacity),
    active_fault_count: num(raw.active_fault_count),
    active_ticket_id: raw.active_ticket_id ? str(raw.active_ticket_id) : null,
    sla_breach_state: (raw.sla_breach_state as TwinSpace['sla_breach_state']) ?? null,
    has_active_lock: Boolean(raw.has_active_lock),
    queue_count: raw.queue_count === null || raw.queue_count === undefined ? undefined : num(raw.queue_count),
    rerouted_to_bot_code: raw.rerouted_to_bot_code ? str(raw.rerouted_to_bot_code) : null,
    paper_percent: raw.paper_percent === null || raw.paper_percent === undefined ? undefined : num(raw.paper_percent),
  };
}

function mapComplaint(raw: Raw): Complaint {
  const assets = Array.isArray(raw.target_assets)
    ? (raw.target_assets as Raw[]).map((asset) => str(asset.asset_code)).filter(Boolean)
    : [];
  return {
    id: str(raw.id),
    ticket_number: str(raw.ticket_number),
    space_code: str(raw.space_code),
    title: raw.title ? str(raw.title) : undefined,
    description: str(raw.description),
    category: str(raw.category ?? 'ELECTRICAL'),
    urgency: (raw.urgency as Complaint['urgency']) ?? 'MEDIUM',
    status: str(raw.status ?? 'OPEN'),
    moderation_status: raw.moderation_status ? str(raw.moderation_status) : undefined,
    public_reporter_label: str(raw.reporter_label ?? raw.public_reporter_label ?? 'Campus member'),
    is_anonymous: Boolean(raw.is_anonymous),
    photo_url: raw.photo_url ? str(raw.photo_url) : null,
    affected_upvote_count: num(raw.affected_count ?? raw.affected_upvote_count),
    target_assets: assets,
    parent_complaint_id: raw.parent_complaint_id ? str(raw.parent_complaint_id) : null,
    created_at: str(raw.created_at),
    vault_token: raw.vault_token ? str(raw.vault_token) : null,
  };
}

function mapWorkOrder(raw: Raw): WorkOrder {
  const statusMap: Record<string, WorkOrder['status']> = {
    PENDING_ASSIGNMENT: 'OPEN',
    ASSIGNED: 'ASSIGNED',
    IN_PROGRESS: 'IN_PROGRESS',
    BLOCKED_PARTS: 'BLOCKED_PARTS',
    COMPLETED: 'RESOLVED',
    RESOLVED: 'RESOLVED',
    CLOSED: 'CLOSED',
    CANCELLED: 'CANCELLED',
  };
  const score = num(raw.priority_score);
  return {
    id: str(raw.id),
    work_order_number: str(raw.work_order_number ?? raw.wo_number),
    complaint_id: raw.complaint_id ? str(raw.complaint_id) : undefined,
    space_code: str(raw.space_code),
    title: raw.title ? str(raw.title) : undefined,
    description: raw.description ? str(raw.description) : undefined,
    status: statusMap[str(raw.status)] ?? 'OPEN',
    priority: score >= 95 ? 'CRITICAL' : score >= 75 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW',
    priority_score: score,
    required_skill: str(raw.required_skill),
    required_risk_clearance: str(raw.required_risk_clearance),
    assigned_staff_code: raw.assigned_staff_code ? str(raw.assigned_staff_code) : null,
    assigned_staff_name: raw.assigned_staff_name ? str(raw.assigned_staff_name) : null,
    reassignment_count: num(raw.reassignment_count),
    last_reassignment_reason: raw.last_reassignment_reason ? str(raw.last_reassignment_reason) : undefined,
    required_parts: [],
    created_at: str(raw.created_at),
  };
}

function mapIncident(raw: Raw): Incident {
  return {
    id: str(raw.id),
    incident_number: str(raw.incident_number),
    title: str(raw.title),
    correlation_type: (raw.correlation_type as Incident['correlation_type']) ?? 'MANUAL',
    root_cause: raw.root_cause ? str(raw.root_cause) : undefined,
    distribution_board_code: raw.distribution_board_code ? str(raw.distribution_board_code) : undefined,
    ai_summary_text: str(raw.ai_summary_text),
    affected_space_codes: Array.isArray(raw.affected_space_codes)
      ? (raw.affected_space_codes as unknown[]).map(str)
      : str(raw.affected_rooms_csv).split(',').filter(Boolean),
    affected_class_count: num(raw.affected_class_count),
    affected_student_count: num(raw.affected_student_count ?? raw.total_students_impacted),
    chronic_replacement_advised: Boolean(raw.chronic_replacement_advised),
    status: str(raw.status),
    created_at: str(raw.created_at),
  };
}

function mapSla(raw: Raw): SlaClock {
  const target = num(raw.resolution_target_mins ?? raw.target_minutes);
  const elapsed = num(raw.elapsed_active_mins ?? raw.elapsed_active_minutes);
  const remaining = Math.max(0, target - Math.round(elapsed));
  return {
    id: str(raw.id),
    work_order_id: str(raw.target_id ?? raw.work_order_id),
    work_order_number: raw.work_order_number ? str(raw.work_order_number) : undefined,
    space_code: raw.space_code ? str(raw.space_code) : undefined,
    priority: raw.urgency ? str(raw.urgency) : undefined,
    target_minutes: target,
    elapsed_active_minutes: Math.round(elapsed),
    remaining_minutes: remaining,
    progress_percent: target > 0 ? Math.min(100, Math.round((elapsed / target) * 100)) : 0,
    breach_state: raw.breach_state === 'WARNING_75'
      ? 'WARNING_75'
      : raw.breach_state === 'BREACHED_100'
        ? 'BREACHED_100'
        : 'ON_TRACK',
    is_paused: Boolean(raw.is_paused),
    pause_reason: raw.pause_reason ? str(raw.pause_reason) : null,
    is_closed: Boolean(raw.closed_at),
    closed_at: raw.closed_at ? str(raw.closed_at) : null,
    closed_reason: raw.closed_reason ? str(raw.closed_reason) : null,
    current_escalation_tier: num(raw.current_escalation_tier),
    deadline_at: raw.last_tick_at
      ? new Date(new Date(str(raw.last_tick_at)).getTime() + remaining * 60_000).toISOString()
      : undefined,
    escalation_log: [],
  };
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function mapSlaPolicy(raw: Raw): SlaPolicy {
  const is24x7 = Boolean(raw.is_24x7);
  return {
    priority_code: str(raw.priority_code),
    priority_label: str(raw.priority_label),
    service_name: str(raw.service_name),
    category: nullable(raw.category),
    response_target_mins: num(raw.response_target_mins),
    resolution_target_mins: num(raw.resolution_target_mins),
    response_hours: num(raw.response_hours),
    resolution_hours: num(raw.resolution_hours),
    resolution_days: num(raw.resolution_days),
    is_24x7: is24x7,
    basis: (raw.basis as SlaBasis) ?? (is24x7 ? 'CLOCK' : 'WORKING'),
    description: str(raw.description),
  };
}

function mapSlaCalendarDay(raw: Raw): SlaCalendarDay {
  return {
    day_date: str(raw.day_date),
    is_working_day: Boolean(raw.is_working_day),
    label: nullable(raw.label),
    open_minute: raw.open_minute === null || raw.open_minute === undefined ? null : num(raw.open_minute),
    close_minute: raw.close_minute === null || raw.close_minute === undefined ? null : num(raw.close_minute),
    note: nullable(raw.note),
    opens_at: nullable(raw.opens_at),
    closes_at: nullable(raw.closes_at),
  };
}

function mapSlaWorkingHours(raw: Raw): SlaWorkingHours {
  return {
    opens_at: str(raw.opens_at ?? '09:00'),
    closes_at: str(raw.closes_at ?? '15:00'),
    timezone: str(raw.timezone ?? 'Asia/Kolkata'),
    days: str(raw.days ?? 'Monday to Friday'),
    note: str(raw.note),
  };
}

function mapSlaOfficer(raw: Raw): SlaOfficer {
  return {
    staff_code: str(raw.staff_code),
    full_name: str(raw.full_name),
    primary_skill: str(raw.primary_skill),
    skill_proficiency: num(raw.skill_proficiency),
    area: str(raw.area),
    assigned_jobs: num(raw.assigned_jobs),
    max_jobs: num(raw.max_jobs),
    hourly_cost_inr: num(raw.hourly_cost_inr),
  };
}

function mapSlaBoardRow(raw: Raw): SlaBoardRow {
  const officer = raw.officer ? (raw.officer as Raw) : null;
  const is24x7 = Boolean(raw.is_24x7);
  return {
    clock_id: num(raw.clock_id),
    work_order_id: num(raw.work_order_id),
    work_order_number: str(raw.work_order_number),
    ticket_number: nullable(raw.ticket_number),
    title: nullable(raw.title),
    space_code: str(raw.space_code),
    category: nullable(raw.category),
    urgency: nullable(raw.urgency),
    department_code: str(raw.department_code ?? 'CAMPUS'),
    priority_code: str(raw.priority_code),
    priority_label: str(raw.priority_label),
    service_name: str(raw.service_name),
    policy_note: nullable(raw.policy_note),
    is_24x7: is24x7,
    basis: (raw.basis as SlaBasis) ?? (is24x7 ? 'CLOCK' : 'WORKING'),
    state: (raw.state as SlaClockState) ?? 'HEALTHY',
    breach_state: str(raw.breach_state),
    response_state: (raw.response_state as SlaResponseState) ?? 'PENDING',
    first_response_at: nullable(raw.first_response_at),
    response_target_mins: num(raw.response_target_mins),
    response_elapsed_mins: num(raw.response_elapsed_mins),
    response_remaining_mins: num(raw.response_remaining_mins),
    response_progress_pct: num(raw.response_progress_pct),
    resolution_target_mins: num(raw.resolution_target_mins),
    resolution_elapsed_mins: num(raw.resolution_elapsed_mins),
    resolution_remaining_mins: num(raw.resolution_remaining_mins),
    resolution_progress_pct: num(raw.resolution_progress_pct),
    pause_reason: nullable(raw.pause_reason),
    last_milestone: nullable(raw.last_milestone),
    escalation_tier: num(raw.escalation_tier),
    escalated_at: nullable(raw.escalated_at),
    closed_at: nullable(raw.closed_at),
    closed_reason: nullable(raw.closed_reason),
    officer: officer ? mapSlaOfficer(officer) : null,
    officer_email: nullable(raw.officer_email),
    head_of_department: nullable(raw.head_of_department),
    work_order_status: nullable(raw.work_order_status),
  };
}

function mapSlaBoardSummary(raw: Raw): SlaBoardSummary {
  return {
    total: num(raw.total),
    healthy: num(raw.healthy),
    warning: num(raw.warning),
    breached: num(raw.breached),
    paused: num(raw.paused),
    closed: num(raw.closed),
    response_pending: num(raw.response_pending),
  };
}

function mapSlaComplianceTotals(raw: Raw): SlaComplianceTotals {
  return {
    requests: num(raw.requests),
    closed: num(raw.closed),
    met: num(raw.met),
    missed: num(raw.missed),
    open: num(raw.open),
    open_breached: num(raw.open_breached),
    compliance_pct: num(raw.compliance_pct),
    responded: num(raw.responded),
    response_missed: num(raw.response_missed),
    response_compliance_pct: num(raw.response_compliance_pct),
    avg_resolution_mins: num(raw.avg_resolution_mins),
  };
}

function mapSlaDepartmentCompliance(raw: Raw): SlaDepartmentCompliance {
  return {
    department_code: str(raw.department_code),
    services: Array.isArray(raw.services) ? (raw.services as unknown[]).map(str).filter(Boolean) : [],
    requests: num(raw.requests),
    closed: num(raw.closed),
    met: num(raw.met),
    breached: num(raw.breached),
    open: num(raw.open),
    compliance_pct: num(raw.compliance_pct),
    avg_resolution_mins: num(raw.avg_resolution_mins),
  };
}

function mapSlaPriorityCompliance(raw: Raw): SlaPriorityCompliance {
  return {
    priority_code: str(raw.priority_code),
    requests: num(raw.requests),
    closed: num(raw.closed),
    met: num(raw.met),
    breached: num(raw.breached),
    compliance_pct: num(raw.compliance_pct),
  };
}

function mapSlaServiceCompliance(raw: Raw): SlaServiceCompliance {
  return {
    service_name: str(raw.service_name),
    requests: num(raw.requests),
    closed: num(raw.closed),
    met: num(raw.met),
    compliance_pct: num(raw.compliance_pct),
  };
}

function mapInventory(raw: Raw): InventoryItem {
  const onHand = num(raw.on_hand_qty);
  const reserved = num(raw.reserved_qty);
  return {
    id: str(raw.id),
    sku_code: str(raw.sku_code),
    name: str(raw.part_name ?? raw.name),
    category: str(raw.category),
    unit: 'unit',
    on_hand_qty: onHand,
    reserved_qty: reserved,
    available_qty: Math.max(0, onHand - reserved),
    reorder_level: num(raw.reorder_threshold ?? raw.reorder_level),
    unit_cost_inr: num(raw.unit_cost_inr),
  };
}

function mapPurchaseRequest(raw: Raw): PurchaseRequest {
  const requester = raw.requester as Raw | null;
  return {
    id: str(raw.id),
    pr_number: str(raw.pr_number),
    work_order_id: raw.linked_work_order_id ? str(raw.linked_work_order_id) : undefined,
    work_order_number: raw.work_order_number ? str(raw.work_order_number) : undefined,
    requested_by_user_id: str(raw.requested_by_user_id),
    requested_by_name: requester ? str(requester.full_name) : str(raw.requested_by_name ?? `User ${raw.requested_by_user_id}`),
    department_code: str(raw.department_code),
    status: str(raw.status) as PurchaseRequest['status'],
    total_cost_inr: num(raw.total_cost_inr),
    items: [{ sku_code: str(raw.sku_code), quantity: num(raw.quantity_requested), unit_cost_inr: num(raw.unit_cost_inr) }],
    override_reason: raw.override_reason ? str(raw.override_reason) : undefined,
    approvals: [],
    created_at: str(raw.created_at),
  };
}

function mapNotification(raw: Raw): NotificationLog {
  return {
    id: str(raw.id),
    channel: (raw.channel as NotificationLog['channel']) ?? 'EMAIL',
    recipient: str(raw.recipient),
    subject: raw.subject ? str(raw.subject) : undefined,
    payload: raw.payload_json ? str(raw.payload_json) : '',
    status: str(raw.delivery_status ?? raw.status),
    created_at: str(raw.created_at),
  };
}

function mapAudit(raw: Raw): AuditEntry {
  return {
    id: str(raw.id),
    sequence_number: num(raw.id),
    timestamp: str(raw.timestamp),
    actor_email: str(raw.actor_email),
    actor_role: mapRole(str(raw.actor_role)),
    action: str(raw.action),
    resource_type: str(raw.resource_type),
    resource_id: str(raw.resource_id),
    outcome: (raw.outcome as AuditEntry['outcome']) ?? 'ALLOWED',
    rule_fired: raw.rule_fired ? str(raw.rule_fired) : null,
    reason: raw.reason ? str(raw.reason) : null,
    prev_hash: '',
    row_hash: '',
  };
}

function mapPeriodCard(raw: Raw | null): SpaceDetail['period_cards']['current_period'] {
  if (!raw) return null;
  return {
    period_number: raw.period_number === null || raw.period_number === undefined ? null : num(raw.period_number),
    time_label: str(raw.time_label),
    minutes_remaining: raw.minutes_remaining === undefined ? undefined : num(raw.minutes_remaining),
    class_code: raw.class_code ? str(raw.class_code) : null,
    department: raw.department ? str(raw.department) : undefined,
    year: raw.year ? num(raw.year) : undefined,
    section: raw.section ? str(raw.section) : undefined,
    student_strength: raw.student_strength ? num(raw.student_strength) : undefined,
    room_capacity: raw.room_capacity ? num(raw.room_capacity) : undefined,
    subject_title: raw.subject_title ? str(raw.subject_title) : undefined,
    session_type: raw.session_type ? str(raw.session_type) : undefined,
    faculty_name: raw.faculty_name ? str(raw.faculty_name) : undefined,
    location_status: raw.location_status ? str(raw.location_status) : undefined,
    is_relocated: Boolean(raw.is_relocated),
    relocated_from_code: raw.relocated_from_code ? str(raw.relocated_from_code) : undefined,
    relocated_to_code: raw.relocated_to_code ? str(raw.relocated_to_code) : undefined,
    away_in_lab_code: raw.away_in_lab_code ? str(raw.away_in_lab_code) : undefined,
  };
}

function mapSpaceDetail(raw: Raw): SpaceDetail {
  const space = (raw.space as Raw) ?? {};
  const cards = (raw.period_cards as Raw) ?? {};
  const timeline = Array.isArray(raw.full_day_timeline) ? (raw.full_day_timeline as Raw[]) : [];
  return {
    code: str(raw.code ?? space.code),
    alias_code: space.alias_code ? str(space.alias_code) : undefined,
    kind: (space.kind as SpaceDetail['kind']) ?? 'CLASSROOM',
    name: space.name ? str(space.name) : undefined,
    block: space.block ? str(space.block) : undefined,
    floor: space.floor === null || space.floor === undefined ? undefined : num(space.floor),
    distribution_board_code: space.distribution_board_code ? str(space.distribution_board_code) : undefined,
    visual_state: (space.visual_state as SpaceDetail['visual_state']) ?? 'HEALTHY',
    home_class_code: space.home_class_code ? str(space.home_class_code) : undefined,
    home_student_count: space.home_student_count === null || space.home_student_count === undefined ? undefined : num(space.home_student_count),
    active_lock: raw.space && (raw.space as Raw).active_lock
      ? mapLock((raw.space as Raw).active_lock as Raw)
      : null,
    period_cards: {
      previous_period: mapPeriodCard(cards.previous_period as Raw | null),
      current_period: mapPeriodCard(cards.current_period as Raw | null),
      next_period: mapPeriodCard(cards.next_period as Raw | null),
    },
    full_day_timeline: timeline.map((card) => mapPeriodCard(card)!).filter(Boolean),
    assets: Array.isArray(raw.assets)
      ? (raw.assets as Raw[]).map((asset) => ({
          id: str(asset.asset_code),
          asset_code: str(asset.asset_code),
          asset_type: str(asset.asset_type),
          name: asset.name ? str(asset.name) : undefined,
          slot_index: num(asset.slot_index),
          status: (asset.status as 'OK' | 'DEGRADED' | 'FAULTY') ?? 'OK',
        }))
      : [],
    active_complaints: Array.isArray(raw.active_complaints)
      ? (raw.active_complaints as Raw[]).map(mapComplaint)
      : [],
    correlated_incident: raw.correlated_incident ? mapIncident(raw.correlated_incident as Raw) : null,
    active_work_order: raw.active_work_order ? mapWorkOrder(raw.active_work_order as Raw) : null,
    sla_clock: raw.sla_clock ? mapSla(raw.sla_clock as Raw) : null,
    maintenance_history: Array.isArray(raw.maintenance_history)
      ? (raw.maintenance_history as Raw[]).map((item) => ({
          id: str(item.id),
          asset_code: item.asset_code ? str(item.asset_code) : undefined,
          asset_type: item.asset_type ? str(item.asset_type) : undefined,
          action: str(item.action),
          technician_name: item.technician_name ? str(item.technician_name) : undefined,
          notes: item.notes ? str(item.notes) : undefined,
          completed_at: str(item.completed_at),
        }))
      : [],
  };
}

function mapAssetHistory(raw: Raw): AssetHistory {
  const asset = (raw.asset as Raw) ?? {};
  const stats = (raw.stats as Raw) ?? {};
  const current = raw.current_work_order as Raw | null;
  const optionalNumber = (value: unknown) => value === null || value === undefined || value === '' ? undefined : num(value);
  return {
    asset: {
      asset_code: str(asset.asset_code),
      name: str(asset.name),
      asset_type: str(asset.asset_type),
      status: (asset.status as AssetHistory['asset']['status']) ?? 'OK',
      sku_code: asset.sku_code ? str(asset.sku_code) : null,
      installed_at: asset.installed_at ? str(asset.installed_at) : null,
      age_days: optionalNumber(asset.age_days) ?? null,
      failure_count_30d: num(asset.failure_count_30d),
      space_code: str(asset.space_code),
      space_kind: asset.space_kind ? str(asset.space_kind) : undefined,
      space_name: asset.space_name ? str(asset.space_name) : undefined,
      block: asset.block ? str(asset.block) : undefined,
      floor: asset.floor === null || asset.floor === undefined ? undefined : num(asset.floor),
    },
    stats: {
      repair_count: num(stats.repair_count),
      total_downtime_mins: num(stats.total_downtime_mins),
      total_parts_cost_inr: num(stats.total_parts_cost_inr),
      total_labour_cost_inr: num(stats.total_labour_cost_inr),
      total_cost_inr: num(stats.total_cost_inr),
      avg_downtime_mins: num(stats.avg_downtime_mins),
      last_repair_at: stats.last_repair_at ? str(stats.last_repair_at) : null,
      days_since_last_repair: optionalNumber(stats.days_since_last_repair) ?? null,
      health_score: num(stats.health_score),
      health_label: (stats.health_label as AssetHistory['stats']['health_label']) ?? 'STABLE',
    },
    current_work_order: current ? {
      wo_number: str(current.wo_number),
      status: str(current.status),
      priority_score: current.priority_score === null || current.priority_score === undefined ? undefined : num(current.priority_score),
      assigned_staff_code: current.assigned_staff_code ? str(current.assigned_staff_code) : null,
      technician_name: current.technician_name ? str(current.technician_name) : null,
      created_at: str(current.created_at),
      age_minutes: num(current.age_minutes),
      complaint_ticket: current.complaint_ticket ? str(current.complaint_ticket) : undefined,
      complaint_title: current.complaint_title ? str(current.complaint_title) : undefined,
    } : null,
    history: Array.isArray(raw.history)
      ? (raw.history as Raw[]).map((record) => ({
          id: str(record.id),
          completed_at: str(record.completed_at),
          work_order_number: record.work_order_number ? str(record.work_order_number) : undefined,
          fault_category: record.fault_category ? str(record.fault_category) : undefined,
          action: str(record.action_taken),
          technician_code: record.technician_code ? str(record.technician_code) : undefined,
          technician_name: record.technician_name ? str(record.technician_name) : undefined,
          technician_role: record.technician_role ? str(record.technician_role) : undefined,
          downtime_mins: num(record.downtime_mins),
          parts_cost_inr: num(record.parts_cost_inr),
          labour_cost_inr: num(record.labour_cost_inr),
          total_cost_inr: num(record.total_cost_inr),
          parts: Array.isArray(record.parts)
            ? (record.parts as Raw[]).map((part) => ({
                sku_code: str(part.sku_code),
                name: str(part.name),
                qty: num(part.qty),
                unit_cost_inr: num(part.unit_cost_inr),
              }))
            : [],
          complaint_ticket: record.complaint_ticket ? str(record.complaint_ticket) : undefined,
          complaint_title: record.complaint_title ? str(record.complaint_title) : undefined,
        }))
      : [],
    parts_summary: Array.isArray(raw.parts_summary)
      ? (raw.parts_summary as Raw[]).map((part) => ({
          sku_code: str(part.sku_code),
          name: str(part.name),
          quantity: num(part.quantity),
          spend_inr: num(part.spend_inr),
          last_used_at: part.last_used_at ? str(part.last_used_at) : null,
        }))
      : [],
  };
}

function mapLock(raw: Raw): ResourceLock {
  return {
    id: str(raw.id),
    resource_type: (raw.resource_type as ResourceType) ?? 'ROOM',
    resource_id: str(raw.resource_id),
    locked_by_user_id: raw.locked_by_user_id ? str(raw.locked_by_user_id) : undefined,
    locked_by_name: str(raw.locked_by_name),
    locked_by_role: mapRole(str(raw.locked_by_role)),
    acquired_seconds_ago: raw.acquired_seconds_ago === undefined ? undefined : num(raw.acquired_seconds_ago),
    expires_in_seconds: num(raw.expires_in_seconds),
    expires_at: str(raw.expires_at),
  };
}

function mapRoomConflict(raw: Raw): RoomConflict {
  return {
    kind: (raw.kind as RoomConflict['kind']) ?? 'CLASS',
    label: str(raw.label),
    class_code: raw.class_code ? str(raw.class_code) : null,
    period_number: raw.period_number === undefined || raw.period_number === null ? undefined : num(raw.period_number),
    booking_id: raw.booking_id ? str(raw.booking_id) : undefined,
    owner: raw.owner ? str(raw.owner) : null,
    student_strength: raw.student_strength === undefined ? undefined : num(raw.student_strength),
    starts_at: str(raw.starts_at),
    ends_at: str(raw.ends_at),
  };
}

function mapBooking(raw: Raw): Booking {
  return {
    id: str(raw.id),
    space_code: str(raw.space_code),
    class_code: raw.class_code ? str(raw.class_code) : null,
    purpose: str(raw.purpose),
    starts_at: str(raw.starts_at),
    ends_at: str(raw.ends_at),
    status: (raw.status as Booking['status']) ?? 'ACTIVE',
    booked_by_name: raw.booked_by_name ? str(raw.booked_by_name) : null,
    department_code: raw.department_code ? str(raw.department_code) : null,
    created_at: raw.created_at ? str(raw.created_at) : undefined,
  };
}

function mapBookingResult(raw: Raw): BookingResult {
  return {
    success: Boolean(raw.success),
    error: raw.error ? str(raw.error) : undefined,
    reason: raw.reason ? str(raw.reason) : undefined,
    booking_id: raw.booking_id === undefined ? undefined : str(raw.booking_id),
    space_code: raw.space_code ? str(raw.space_code) : undefined,
    starts_at: raw.starts_at ? str(raw.starts_at) : undefined,
    ends_at: raw.ends_at ? str(raw.ends_at) : undefined,
    status: raw.status ? str(raw.status) : undefined,
    idempotent: raw.idempotent === undefined ? undefined : Boolean(raw.idempotent),
    already_cancelled: raw.already_cancelled === undefined ? undefined : Boolean(raw.already_cancelled),
    conflicts: Array.isArray(raw.conflicts) ? (raw.conflicts as Raw[]).map(mapRoomConflict) : [],
    alternatives: Array.isArray(raw.alternatives)
      ? (raw.alternatives as Raw[]).map((item) => ({
          room_code: str(item.room_code),
          capacity: num(item.capacity),
        }))
      : [],
    student_strength: raw.student_strength === undefined ? undefined : num(raw.student_strength),
    room_capacity: raw.room_capacity === undefined ? undefined : num(raw.room_capacity),
    visual_state: raw.visual_state ? str(raw.visual_state) : undefined,
  };
}

function mapScenarioSummary(raw: Raw): ScenarioSummary {
  const optionalNumber = (value: unknown) =>
    value === undefined || value === null ? undefined : num(value);
  return {
    scenario_key: raw.scenario_key ? str(raw.scenario_key) : undefined,
    title: raw.title ? str(raw.title) : undefined,
    space_code: raw.space_code ? str(raw.space_code) : undefined,
    space_type: (raw.space_type as ScenarioSummary['space_type']) ?? undefined,
    complaint_id: optionalNumber(raw.complaint_id),
    ticket_number: raw.ticket_number ? str(raw.ticket_number) : undefined,
    work_order_id: optionalNumber(raw.work_order_id),
    work_order_number: raw.work_order_number ? str(raw.work_order_number) : undefined,
    sla_clock_id: optionalNumber(raw.sla_clock_id),
    description: raw.description ? str(raw.description) : undefined,
    prior_assets: Array.isArray(raw.prior_assets)
      ? (raw.prior_assets as Raw[]).map((asset) => ({
          asset_code: str(asset.asset_code),
          status: str(asset.status),
        }))
      : [],
    error: raw.error,
  };
}

function mapScenarioRun(raw: Raw): ScenarioRun {
  const summary = typeof raw.summary_json === 'string'
    ? (JSON.parse(raw.summary_json) as Raw)
    : ((raw.summary_json as Raw) ?? {});
  return {
    id: str(raw.id),
    scenario_key: (raw.scenario_key as ScenarioRun['scenario_key']) ?? 'WATER_LEAK',
    title: str(raw.title),
    status: (raw.status as ScenarioRun['status']) ?? 'RUNNING',
    started_at: str(raw.started_at),
    completed_at: raw.completed_at ? str(raw.completed_at) : null,
    summary_json: mapScenarioSummary(summary),
    created_by: raw.created_by ? str(raw.created_by) : null,
  };
}

function mapScenarioResult(raw: Raw): ScenarioResult {
  return {
    ...mapScenarioSummary(raw),
    success: Boolean(raw.success),
    error: raw.error ? str(raw.error) : undefined,
    idempotent: raw.idempotent === undefined ? undefined : Boolean(raw.idempotent),
    run_id: raw.run_id === undefined ? undefined : str(raw.run_id),
    status: raw.status ? str(raw.status) : undefined,
    already_reverted: raw.already_reverted === undefined ? undefined : Boolean(raw.already_reverted),
  };
}

async function fetchWorkOrder(id: string | number): Promise<WorkOrder> {
  const { data, error } = await supabase.from('work_orders').select('*').eq('id', Number(id)).maybeSingle();
  if (error || !data) throw new ApiError(error?.message ?? 'Work order not found', 404, null);
  return mapWorkOrder(data as Raw);
}

async function fetchPurchaseRequest(id: string | number): Promise<PurchaseRequest> {
  const { data, error } = await supabase
    .from('purchase_requests')
    .select('*, requester:users!requested_by_user_id(full_name)')
    .eq('id', Number(id))
    .maybeSingle();
  if (error || !data) throw new ApiError(error?.message ?? 'Purchase request not found', 404, null);
  return mapPurchaseRequest(data as Raw);
}

export const api = {
  auth: {
    login: async (email: string, password: string): Promise<LoginResponse> => {
      cachedProfile = null;
      const { data, error } = await signIn(email, password);
      if (error) {
        const message = error.message.toLowerCase();
        throw new ApiError(
          message.includes('invalid login')
            ? 'That email and password do not match an account.'
            : message.includes('rate limit')
              ? 'The campus mail service is busy right now. Please try again.'
              : 'Unable to sign in right now. Please try again.',
          401,
          null,
        );
      }
      localStorage.setItem(TOKEN_STORAGE_KEY, data.session?.access_token ?? '');
      const user = await api.auth.me();
      return { access_token: data.session?.access_token ?? '', token_type: 'bearer', user };
    },
    me: (): Promise<User> => loadMe(),
  },

  twin: {
    overview: async (): Promise<TwinOverview> => {
      const rows = (await rpc.twinOverview()) as Raw[];
      return { spaces: rows.map(mapTwinSpace), generated_at: new Date().toISOString() };
    },
    space: async (code: string): Promise<SpaceDetail> => {
      const raw = (await rpc.inspector(code)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), 404, raw);
      return mapSpaceDetail(raw);
    },
    assetHistory: async (assetCode: string): Promise<AssetHistory> => {
      const raw = (await rpc.assetHistory(assetCode)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), raw.error === 'FORBIDDEN' ? 403 : 404, raw);
      return mapAssetHistory(raw);
    },
  },

  bookings: {
    list: async (): Promise<Booking[]> => {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = (await rpc.listBookings(from, 200)) as Raw[];
      return rows.map(mapBooking);
    },
    occupancy: async (spaceCode: string, from: string, to: string): Promise<RoomOccupancy> => {
      const raw = (await rpc.roomOccupancy(spaceCode, from, to)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), 404, raw);
      return {
        space_code: str(raw.space_code),
        capacity: num(raw.capacity),
        visual_state: (raw.visual_state as RoomOccupancy['visual_state']) ?? 'HEALTHY',
        from: str(raw.from),
        to: str(raw.to),
        conflicts: Array.isArray(raw.conflicts) ? (raw.conflicts as Raw[]).map(mapRoomConflict) : [],
      };
    },
    create: async (payload: {
      spaceCode: string;
      startsAt: string;
      endsAt: string;
      purpose: string;
      classCode?: string | null;
      requestKey?: string | null;
    }): Promise<BookingResult> => {
      const profile = await loadProfile();
      const raw = (await rpc.createBooking({ ...payload, email: profile.email })) as Raw;
      return mapBookingResult(raw);
    },
    cancel: async (bookingId: string): Promise<BookingResult> => {
      const profile = await loadProfile();
      const raw = (await rpc.cancelBooking(Number(bookingId), profile.email)) as Raw;
      if (!raw.success) throw new ApiError(str(raw.error ?? 'Cancellation failed'), 409, raw);
      return mapBookingResult(raw);
    },
  },

  scenarios: {
    list: async (): Promise<ScenarioRun[]> => {
      const rows = (await rpc.listScenarios()) as Raw[];
      return rows.map(mapScenarioRun);
    },
    run: async (key: 'WATER_LEAK' | 'POWER_FAULT_LAB'): Promise<ScenarioResult> => {
      const profile = await loadProfile();
      const raw = (await rpc.runScenario(key, profile.email)) as Raw;
      return mapScenarioResult(raw);
    },
    reset: async (runId: string): Promise<ScenarioResult> => {
      const profile = await loadProfile();
      const raw = (await rpc.resetScenario(Number(runId), profile.email)) as Raw;
      return mapScenarioResult(raw);
    },
  },

  pulse: {
    status: async (): Promise<PulseStatus> => (await rpc.pulseStatus()) as PulseStatus,
    configure: async (patch: {
      enabled?: boolean | null;
      intervalMinutes?: number | null;
      maxOpenSimulated?: number | null;
      autoHealHours?: number | null;
    }): Promise<Raw> =>
      (await rpc.pulseConfigure(
        patch.enabled ?? null,
        patch.intervalMinutes ?? null,
        patch.maxOpenSimulated ?? null,
        patch.autoHealHours ?? null,
      )) as Raw,
    runNow: async (): Promise<PulseInjectResult> => (await rpc.pulseRunNow()) as PulseInjectResult,
    revert: async (eventId: number): Promise<Raw> => (await rpc.pulseRevert(eventId)) as Raw,
  },

  clock: {
    get: async (): Promise<CampusClock> => {
      const { data, error } = await supabase.from('campus_clock_state').select('*').eq('id', 1).maybeSingle();
      if (error || !data) throw new ApiError(error?.message ?? 'Clock unavailable', 400, null);
      return {
        day_of_week: str(data.active_day) as CampusClock['day_of_week'],
        current_time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        active_period: num(data.active_period),
        minutes_remaining: Math.max(0, num(data.period_duration_mins) - num(data.period_elapsed_mins)),
        is_break: false,
      };
    },
    update: async (payload: Partial<Pick<CampusClock, 'day_of_week' | 'current_time'>>): Promise<CampusClock> => {
      const current = await api.clock.get();
      const day = payload.day_of_week ?? current.day_of_week;
      let period = current.active_period ?? 1;
      if (payload.current_time) {
        const [hour, minute] = payload.current_time.split(':').map(Number);
        const minutes = hour * 60 + minute;
        const starts = [540, 590, 655, 705, 800, 850];
        period = 1;
        starts.forEach((start, index) => { if (minutes >= start) period = index + 1; });
      }
      await rpc.setClock(day, period);
      return api.clock.get();
    },
  },

  locks: {
    claim: async (resourceType: ResourceType, resourceId: string): Promise<ResourceLock> => {
      const profile = await loadProfile();
      const result = (await rpc.claimLock(resourceType, resourceId, profile.email, profile.full_name, profile.role)) as Raw;
      if (!result.success) {
        throw new ApiError(str(result.error ?? 'Lock unavailable'), 409, result);
      }
      return mapLock(result.lock as Raw);
    },
    heartbeat: async (lockId: string): Promise<ResourceLock> => {
      const { data, error } = await supabase.from('resource_locks').select('*').eq('id', Number(lockId)).maybeSingle();
      if (error || !data) throw new ApiError('Lock expired', 404, null);
      return api.locks.claim(data.resource_type as ResourceType, str(data.resource_id));
    },
    release: async (lockId: string): Promise<void> => {
      const profile = await loadProfile();
      await rpc.supaReleaseLock(Number(lockId), profile.email);
    },
  },

  operations: {
    roomConflicts: async (spaceCode: string, day: string, fromPeriod: number): Promise<RoomConflictResult> => {
      const raw = (await rpc.relocationCandidates(spaceCode, day, fromPeriod)) as Raw;
      const session = (raw.session as Raw) ?? {};
      return {
        faulted_space_code: spaceCode,
        affected_sessions: session.class_code ? [{
          period_number: num(session.period_number ?? fromPeriod),
          class_code: str(session.class_code),
          student_strength: num(session.student_strength),
          subject_title: '',
          faculty_staff_code: '',
        }] : [],
        available_alternates: Array.isArray(raw.available_candidates)
          ? (raw.available_candidates as Raw[]).map((candidate) => ({
              space_code: str(candidate.room_code),
              score: num(candidate.score),
              explanation: str(candidate.why_reason),
              capacity: num(candidate.capacity),
            }))
          : [],
        unavailable_spaces: Array.isArray(raw.unavailable_rooms)
          ? (raw.unavailable_rooms as Raw[]).map((room) => ({
              code: str(room.room_code),
              reason: str(room.reason),
            }))
          : [],
        preflight_checks: [],
      };
    },
    relocate: async (payload: {
      faulted_space_code: string;
      target_alternate_code: string;
      day_of_week: string;
      from_period: number;
      lock_id: string;
    }): Promise<WorkOrder | { status: string }> => {
      const profile = await loadProfile();
      const result = (await rpc.executeRelocation(
        payload.faulted_space_code,
        payload.target_alternate_code,
        payload.day_of_week,
        payload.from_period,
        profile.email,
        profile.role,
      )) as Raw;
      if (!result.success) throw new ApiError(str(result.error ?? 'Relocation failed'), 409, result);
      return { status: 'RELOCATED' };
    },
    staffRanking: async (workOrderId: string): Promise<StaffRankingResult> => {
      const raw = (await rpc.rankStaff(Number(workOrderId))) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), 403, raw);
      return {
        work_order_id: str(raw.work_order_id),
        available_ranked: Array.isArray(raw.available_ranked)
          ? (raw.available_ranked as Raw[]).map((candidate) => ({
              staff_code: str(candidate.staff_code),
              full_name: str(candidate.full_name),
              primary_skill: str(candidate.primary_skill),
              risk_clearance: str(candidate.risk_clearance ?? 'STANDARD'),
              skill_proficiency: candidate.skill_proficiency === null || candidate.skill_proficiency === undefined
                ? undefined
                : num(candidate.skill_proficiency),
              is_on_shift: candidate.is_on_shift === null || candidate.is_on_shift === undefined
                ? undefined
                : Boolean(candidate.is_on_shift),
              is_on_leave: candidate.is_on_leave === null || candidate.is_on_leave === undefined
                ? undefined
                : Boolean(candidate.is_on_leave),
              current_block_location: candidate.current_block_location
                ? str(candidate.current_block_location)
                : undefined,
              current_active_jobs: num(candidate.current_active_jobs),
              max_concurrent_jobs: num(candidate.max_concurrent_jobs),
              score: num(candidate.score),
              score_breakdown: ((candidate.breakdown as Raw)?.terms as Record<string, number>) ?? {},
            }))
          : [],
        unavailable_staff: Array.isArray(raw.unavailable_staff)
          ? (raw.unavailable_staff as Raw[]).map((staff) => ({
              code: str(staff.staff_code),
              name: str(staff.full_name),
              reason: str(staff.reason),
            }))
          : [],
        preflight_checks: [],
      };
    },
    workforce: async (): Promise<WorkforceSummary> => {
      const raw = (await rpc.workforceSummary()) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), 403, raw);
      return {
        total: num(raw.total),
        on_shift: num(raw.on_shift),
        on_leave: num(raw.on_leave),
        available: num(raw.available),
        by_skill: Array.isArray(raw.by_skill)
          ? (raw.by_skill as Raw[]).map((skill) => ({
              skill: str(skill.skill),
              total: num(skill.total),
              on_shift: num(skill.on_shift),
              available: num(skill.available),
            }))
          : [],
        staff: Array.isArray(raw.staff)
          ? (raw.staff as Raw[]).map((person) => ({
              staff_code: str(person.staff_code),
              full_name: str(person.full_name),
              primary_skill: str(person.primary_skill),
              shift_code: str(person.shift_code),
              is_on_shift: Boolean(person.is_on_shift),
              is_on_leave: Boolean(person.is_on_leave),
              current_active_jobs: num(person.current_active_jobs),
              max_concurrent_jobs: num(person.max_concurrent_jobs),
            }))
          : [],
      };
    },
    staffProfile: async (staffCode: string): Promise<StaffProfile> => {
      const raw = (await rpc.staffProfile(staffCode)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), raw.error === 'STAFF_NOT_FOUND' ? 404 : 403, raw);
      const stats = (raw.stats ?? {}) as Raw;
      return {
        staff_code: str(raw.staff_code),
        full_name: str(raw.full_name),
        email: str(raw.email),
        portal_role: str(raw.portal_role),
        department_code: raw.department_code ? str(raw.department_code) : null,
        staff_category: str(raw.staff_category),
        primary_skill: str(raw.primary_skill),
        skill_proficiency: raw.skill_proficiency === null || raw.skill_proficiency === undefined ? undefined : num(raw.skill_proficiency),
        risk_clearance: str(raw.risk_clearance),
        shift_code: str(raw.shift_code),
        is_on_shift: Boolean(raw.is_on_shift),
        is_on_leave: Boolean(raw.is_on_leave),
        current_block_location: raw.current_block_location ? str(raw.current_block_location) : null,
        hourly_cost_inr: raw.hourly_cost_inr === null || raw.hourly_cost_inr === undefined ? undefined : num(raw.hourly_cost_inr),
        current_active_jobs: num(raw.current_active_jobs),
        max_concurrent_jobs: num(raw.max_concurrent_jobs),
        stats: {
          jobs_total: num(stats.jobs_total),
          jobs_open: num(stats.jobs_open),
          jobs_completed: num(stats.jobs_completed),
          repairs_count: num(stats.repairs_count),
          repair_cost_inr: num(stats.repair_cost_inr),
          avg_downtime_mins: num(stats.avg_downtime_mins),
          last_repair_at: stats.last_repair_at ? str(stats.last_repair_at) : null,
        },
        jobs: Array.isArray(raw.jobs)
          ? (raw.jobs as Raw[]).map((job) => ({
              wo_number: str(job.wo_number),
              space_code: str(job.space_code),
              status: str(job.status),
              required_skill: str(job.required_skill),
              priority_score: job.priority_score === null || job.priority_score === undefined ? undefined : num(job.priority_score),
              created_at: job.created_at ? str(job.created_at) : null,
              completed_at: job.completed_at ? str(job.completed_at) : null,
            }))
          : [],
        repairs: Array.isArray(raw.repairs)
          ? (raw.repairs as Raw[]).map((repair) => ({
              asset_code: str(repair.asset_code),
              space_code: str(repair.space_code),
              fault_category: str(repair.fault_category),
              action_taken: str(repair.action_taken),
              completed_at: repair.completed_at ? str(repair.completed_at) : null,
              downtime_mins: repair.downtime_mins === null || repair.downtime_mins === undefined ? undefined : num(repair.downtime_mins),
              total_cost_inr: repair.total_cost_inr === null || repair.total_cost_inr === undefined ? undefined : num(repair.total_cost_inr),
            }))
          : [],
      };
    },
    assignStaff: async (
      workOrderId: string,
      staffCode: string,
      _lockId: string,
      expected?: { assigned_staff_code: string | null; reassignment_count: number },
    ): Promise<WorkOrder> => {
      const profile = await loadProfile();
      const result = (await rpc.assignStaffChecked(
        Number(workOrderId),
        staffCode,
        profile.email,
        profile.role,
        expected ?? { assigned_staff_code: null, reassignment_count: 0 },
      )) as Raw;
      if (!result.success) {
        const error = str(result.error ?? 'Assignment failed');
        throw new ApiError(
          error === 'STALE_ASSIGNMENT'
            ? 'Another dispatcher changed this work order. Refresh the board and retry.'
            : error,
          409,
          result,
        );
      }
      return fetchWorkOrder(workOrderId);
    },
    partsPreflight: async (workOrderId: string): Promise<PartsPreflightResult> => {
      const raw = (await rpc.partsPreflight(Number(workOrderId))) as Raw;
      return {
        work_order_id: str(raw.work_order_id),
        requested_parts: Array.isArray(raw.requested_parts)
          ? (raw.requested_parts as Raw[]).map((part) => ({
              sku_code: str(part.sku_code),
              quantity: num(part.quantity),
            }))
          : [],
        available_parts: Array.isArray(raw.available_parts)
          ? (raw.available_parts as Raw[]).map((part) => ({
              id: str(part.sku_code),
              sku_code: str(part.sku_code),
              name: str(part.part_name),
              category: '',
              unit: 'unit',
              on_hand_qty: num(part.available_qty),
              reserved_qty: 0,
              available_qty: num(part.available_qty),
              reorder_level: 0,
              unit_cost_inr: num(part.unit_cost_inr),
            }))
          : [],
        unavailable_parts: Array.isArray(raw.unavailable_parts)
          ? (raw.unavailable_parts as Raw[]).map((part) => ({
              code: str(part.code),
              name: str(part.name),
              reason: str(part.reason),
            }))
          : [],
        preflight_checks: Array.isArray(raw.preflight_checks) ? (raw.preflight_checks as never[]) : [],
      };
    },
    reserveParts: async (workOrderId: string, parts: PartRequest[], _lockId: string): Promise<WorkOrder> => {
      const profile = await loadProfile();
      const result = (await rpc.reserveParts(
        Number(workOrderId),
        parts.map((part) => ({ sku_code: part.sku_code, qty: part.quantity })),
        profile.email,
        profile.role,
      )) as Raw;
      if (result.success === false && result.error) throw new ApiError(str(result.error), 409, result);
      return fetchWorkOrder(workOrderId);
    },
    complete: async (workOrderId: string, resolutionNotes: string): Promise<WorkOrder> => {
      const profile = await loadProfile();
      const result = (await rpc.completeWorkOrder(Number(workOrderId), resolutionNotes, profile.email)) as Raw;
      if (!result.success) throw new ApiError(str(result.error ?? 'Completion failed'), 409, result);
      return fetchWorkOrder(workOrderId);
    },
    rebalanceStaff: async (staffCode: string, _triggerReason: string): Promise<WorkOrder[]> => {
      const profile = await loadProfile();
      await rpc.shiftChange(staffCode, false, profile.email);
      const { data } = await supabase.from('work_orders').select('*').not('status', 'in', '("RESOLVED","CLOSED","COMPLETED")');
      return ((data ?? []) as Raw[]).map(mapWorkOrder);
    },
  },

  incidents: {
    list: async (): Promise<Incident[]> => {
      const { data, error } = await supabase.from('incidents').select('*').order('created_at', { ascending: false });
      if (error) throw new ApiError(error.message, 400, null);
      return ((data ?? []) as Raw[]).map(mapIncident);
    },
  },

  workOrders: {
    list: async (): Promise<WorkOrder[]> => {
      const query = await supabase
        .from('work_orders')
        .select('*, complaint:complaints(title,description)')
        .order('created_at', { ascending: false });
      if (query.error) {
        const fallback = await supabase.from('work_orders').select('*').order('created_at', { ascending: false });
        if (fallback.error) throw new ApiError(fallback.error.message, 400, null);
        return ((fallback.data ?? []) as Raw[]).map(mapWorkOrder);
      }
      return ((query.data ?? []) as Raw[]).map(mapWorkOrder);
    },
  },

  inventory: {
    list: async (): Promise<InventoryItem[]> => {
      const { data, error } = await supabase.from('inventory_items').select('*').order('sku_code');
      if (error) throw new ApiError(error.message, 400, null);
      return ((data ?? []) as Raw[]).map(mapInventory);
    },
    purchaseRequests: async (): Promise<PurchaseRequest[]> => {
      const query = await supabase
        .from('purchase_requests')
        .select('*, requester:users!requested_by_user_id(full_name)')
        .order('created_at', { ascending: false });
      if (query.error) {
        const fallback = await supabase.from('purchase_requests').select('*').order('created_at', { ascending: false });
        if (fallback.error) throw new ApiError(fallback.error.message, 400, null);
        return ((fallback.data ?? []) as Raw[]).map(mapPurchaseRequest);
      }
      return ((query.data ?? []) as Raw[]).map(mapPurchaseRequest);
    },
    approvalPreflight: async (prId: string): Promise<ApprovalPreflight> => {
      const profile = await loadProfile();
      const raw = (await rpc.purchasePreflight(Number(prId), profile.email)) as Raw;
      return {
        purchase_request_id: str(raw.purchase_request_id ?? prId),
        can_approve: Boolean(raw.can_approve),
        checks: Array.isArray(raw.checks) ? (raw.checks as never[]) : [],
      };
    },
    approve: async (prId: string): Promise<PurchaseRequest> => {
      const profile = await loadProfile();
      const result = (await rpc.decidePurchase(Number(prId), 'APPROVE', profile.email, profile.role, false, null, null)) as Raw;
      if (!result.success) throw new ApiError(str(result.rule_fired ?? result.error ?? 'Approval rejected'), 409, result);
      return fetchPurchaseRequest(prId);
    },
    override: async (prId: string, reason: string, counterSignUserId: string): Promise<PurchaseRequest> => {
      const profile = await loadProfile();
      const { data: user } = await supabase.from('users').select('email').eq('id', Number(counterSignUserId)).maybeSingle();
      if (!user?.email) throw new ApiError('Counter-sign user not found', 404, null);
      const result = (await rpc.decidePurchase(Number(prId), 'APPROVE', profile.email, profile.role, true, reason, user.email)) as Raw;
      if (!result.success) throw new ApiError(str(result.rule_fired ?? result.error ?? 'Override rejected'), 409, result);
      return fetchPurchaseRequest(prId);
    },
    receiveStock: async (prId: string, _receivedItems: PartRequest[]): Promise<PurchaseRequest> => {
      const profile = await loadProfile();
      const result = (await rpc.receiveStock(Number(prId), profile.email)) as Raw;
      if (!result.success) throw new ApiError(str(result.error ?? 'Stock receipt failed'), 409, result);
      return fetchPurchaseRequest(prId);
    },
  },

  sla: {
    list: async (): Promise<SlaClock[]> => {
      const [clockQuery, workOrderQuery] = await Promise.all([
        supabase.from('sla_clocks').select('*').order('id', { ascending: false }),
        supabase.from('work_orders').select('id,wo_number,space_code,assigned_staff_code'),
      ]);
      if (clockQuery.error) throw new ApiError(clockQuery.error.message, 400, null);
      const workOrders = new Map(
        ((workOrderQuery.data ?? []) as Raw[]).map((order) => [num(order.id), order]),
      );
      return ((clockQuery.data ?? []) as Raw[]).map((raw) => {
        const workOrder = workOrders.get(num(raw.target_id));
        return mapSla({
          ...raw,
          work_order_number: workOrder?.wo_number ? str(workOrder.wo_number) : undefined,
          space_code: raw.space_code ?? workOrder?.space_code,
        });
      });
    },
    matrix: async (): Promise<SlaMatrix> => {
      const raw = (await rpc.slaMatrix()) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), raw.error === 'FORBIDDEN' ? 403 : 400, raw);
      return {
        policies: Array.isArray(raw.policies) ? (raw.policies as Raw[]).map(mapSlaPolicy) : [],
        calendar: Array.isArray(raw.calendar) ? (raw.calendar as Raw[]).map(mapSlaCalendarDay) : [],
        working_hours: mapSlaWorkingHours((raw.working_hours as Raw) ?? {}),
      };
    },
    board: async (state: string = 'ALL', limit: number = 120): Promise<SlaBoard> => {
      const raw = (await rpc.slaBoard(state, limit)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), raw.error === 'FORBIDDEN' ? 403 : 400, raw);
      return {
        rows: Array.isArray(raw.rows) ? (raw.rows as Raw[]).map(mapSlaBoardRow) : [],
        summary: mapSlaBoardSummary((raw.summary as Raw) ?? {}),
      };
    },
    compliance: async (days: number = 90): Promise<SlaComplianceReport> => {
      const raw = (await rpc.slaCompliance(days)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), raw.error === 'FORBIDDEN' ? 403 : 400, raw);
      return {
        window_days: num(raw.window_days),
        window_basis: str(raw.window_basis),
        totals: mapSlaComplianceTotals((raw.totals as Raw) ?? {}),
        by_department: Array.isArray(raw.by_department)
          ? (raw.by_department as Raw[]).map(mapSlaDepartmentCompliance)
          : [],
        by_priority: Array.isArray(raw.by_priority)
          ? (raw.by_priority as Raw[]).map(mapSlaPriorityCompliance)
          : [],
        by_service: Array.isArray(raw.by_service)
          ? (raw.by_service as Raw[]).map(mapSlaServiceCompliance)
          : [],
      };
    },
    // The RPC resolves the actor from the session; the email is only a
    // fallback, so the console always passes the signed-in address.
    pauseClock: async (workOrderId: number, reason: string, email: string): Promise<SlaClockAction> => {
      const raw = (await rpc.slaPauseClock(workOrderId, reason, email)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), 400, raw);
      return { success: Boolean(raw.success), error: nullable(raw.error) ?? undefined };
    },
    resumeClock: async (workOrderId: number, email: string): Promise<SlaClockAction> => {
      const raw = (await rpc.slaResumeClock(workOrderId, email)) as Raw;
      if (raw.error) throw new ApiError(str(raw.error), 400, raw);
      return { success: Boolean(raw.success), error: nullable(raw.error) ?? undefined };
    },
  },

  moderation: {
    list: async (): Promise<ModerationItem[]> => {
      const { data, error } = await supabase
        .from('complaints')
        .select('*')
        .in('moderation_status', ['HELD_ABUSIVE', 'HELD_HARMFUL', 'NEEDS_REWRITE'])
        .order('created_at', { ascending: false });
      if (error) throw new ApiError(error.message, 400, null);
      return ((data ?? []) as Raw[]).map((raw) => ({
        id: str(raw.id),
        complaint_id: str(raw.id),
        submitted_text: str(raw.description),
        moderation_status: str(raw.moderation_status) as ModerationItem['moderation_status'],
        moderation_reason: str(raw.moderation_reason),
        public_reporter_label: str(raw.public_reporter_label),
        space_code: str(raw.space_code),
        vault_token: raw.vault_token ? str(raw.vault_token) : undefined,
        is_anonymous: Boolean(raw.is_anonymous),
        created_at: str(raw.created_at),
      }));
    },
    unseal: async (vaultToken: string, reason: string, _policyClause: string) => {
      const profile = await loadProfile();
      const result = (await rpc.breakGlass(vaultToken, profile.email, profile.role, reason)) as Raw;
      if (!result.success) throw new ApiError(str(result.error ?? 'Unseal rejected'), 403, result);
      const { data: audit } = await supabase
        .from('audit_logs')
        .select('id')
        .eq('action', 'BREAK_GLASS_UNSEAL')
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      const identity = (result.identity as Raw) ?? {};
      return {
        identity: {
          user_id: str(identity.user_id ?? identity.email ?? ''),
          email: str(identity.email),
          full_name: str(identity.full_name),
          department_code: identity.department_code ? str(identity.department_code) : undefined,
          year_number: identity.year_number === null || identity.year_number === undefined ? undefined : num(identity.year_number),
        },
        audit_entry_id: audit ? str(audit.id) : '',
      };
    },
  },

  integrations: {
    receiveEmail: async (payload: { from_email: string; subject: string; body: string }) => {
      const profile = await loadProfile();
      const text = `${payload.subject}\n${payload.body}`;
      const match = text.match(/\b([ABC])(\d)-0?([1-6])\b/i);
      const space = match ? `${match[1].toUpperCase()}${Number(match[2]) || 1}-0${match[3]}` : 'C1-01';
      const result = (await rpc.submitComplaint({
        email: payload.from_email,
        full_name: payload.from_email.split('@')[0],
        role: 'STUDENT',
        is_anonymous: false,
        space_code: space,
        description: text,
        source_channel: 'EMAIL_INBOX',
        actor_email: profile.email,
      })) as Raw;
      if (result.error) throw new ApiError(str(result.error), 400, result);
      const complaint = (result.complaint as Raw) ?? {};
      return {
        complaint_id: complaint.id ? str(complaint.id) : undefined,
        moderation_status: str(result.moderation_status ?? 'APPROVED'),
        message: `Processed ${str(complaint.ticket_number)}`,
      };
    },
    notifications: async (): Promise<NotificationLog[]> => {
      const { data, error } = await supabase.from('notification_logs').select('*').order('id', { ascending: false }).limit(100);
      if (error) throw new ApiError(error.message, 400, null);
      return ((data ?? []) as Raw[]).map(mapNotification);
    },
  },

  timetable: {
    validate: async (): Promise<TimetableValidation> => {
      return (await rpc.timetableValidate()) as TimetableValidation;
    },
    forClass: async (classCode: string): Promise<TimetableSlot[]> => {
      const { data, error } = await supabase
        .from('timetable_slots')
        .select('*, student_class:student_classes(year_number,section_letter,student_strength,home_room_code)')
        .eq('class_code', classCode)
        .order('day_of_week')
        .order('period_number');
      if (error) throw new ApiError(error.message, 400, null);
      return ((data ?? []) as Raw[]).map((raw) => {
        const sc = (raw.student_class as Raw) ?? {};
        return {
          id: str(raw.id),
          day_of_week: str(raw.day_of_week),
          period_number: num(raw.period_number),
          class_code: str(raw.class_code),
          year: sc.year_number ? num(sc.year_number) : undefined,
          section: sc.section_letter ? str(sc.section_letter) : undefined,
          student_strength: sc.student_strength ? num(sc.student_strength) : undefined,
          subject_title: str(raw.subject_title),
          session_type: str(raw.session_type) as TimetableSlot['session_type'],
          faculty_name: str(raw.faculty_staff_code),
          home_room_code: sc.home_room_code ? str(sc.home_room_code) : '',
          effective_space_code: str(raw.effective_space_code),
          lab_code: raw.session_type === 'LAB' ? str(raw.effective_space_code) : undefined,
          is_relocated: Boolean(raw.is_relocated),
          relocated_from_code: raw.relocated_from_code ? str(raw.relocated_from_code) : undefined,
        };
      });
    },
    forSpace: async (spaceCode: string): Promise<TimetableSlot[]> => {
      const { data, error } = await supabase
        .from('timetable_slots')
        .select('*')
        .eq('effective_space_code', spaceCode)
        .order('day_of_week')
        .order('period_number');
      if (error) throw new ApiError(error.message, 400, null);
      return ((data ?? []) as Raw[]).map((raw) => ({
        id: str(raw.id),
        day_of_week: str(raw.day_of_week),
        period_number: num(raw.period_number),
        class_code: str(raw.class_code),
        subject_title: str(raw.subject_title),
        session_type: str(raw.session_type) as TimetableSlot['session_type'],
        faculty_name: str(raw.faculty_staff_code),
        home_room_code: '',
        effective_space_code: str(raw.effective_space_code),
        lab_code: raw.session_type === 'LAB' ? str(raw.effective_space_code) : undefined,
        is_relocated: Boolean(raw.is_relocated),
        relocated_from_code: raw.relocated_from_code ? str(raw.relocated_from_code) : undefined,
      }));
    },
  },

  audit: {
    list: async (query = ''): Promise<AuditEntry[]> => {
      let request = supabase.from('audit_logs').select('*').order('id', { ascending: false }).limit(200);
      if (query) {
        request = request.or(`action.ilike.%${query}%,actor_email.ilike.%${query}%,resource_id.ilike.%${query}%`);
      }
      const { data, error } = await request;
      if (error) throw new ApiError(error.message, 400, null);
      return ((data ?? []) as Raw[]).map(mapAudit);
    },
    verify: async (): Promise<AuditVerification> => {
      const raw = (await rpc.verifyAudit()) as Raw;
      return {
        verified: Boolean(raw.verified ?? raw.chain_valid),
        total_entries: num(raw.total_entries ?? raw.verified_row_count),
        head_hash: str(raw.head_hash ?? ''),
      };
    },
  },
};

// Helpers used by the auth store.
export async function signOutAdmin(): Promise<void> {
  cachedProfile = null;
  await signOut();
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}
