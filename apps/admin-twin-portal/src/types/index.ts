export type Role =
  | 'MAINTENANCE_TECHNICIAN'
  | 'INCIDENT_MANAGER'
  | 'FACILITIES_ADMIN'
  | 'DEPARTMENT_MANAGER'
  | 'PROCUREMENT_APPROVER'
  | 'SYSTEM_ADMIN';

export type WorkspaceId =
  | 'twin'
  | 'dispatch'
  | 'inventory'
  | 'sla'
  | 'moderation'
  | 'integrations'
  | 'timetable'
  | 'audit'
  | 'analytics';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  department_code?: string;
  staff_code?: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export type VisualState = 'HEALTHY' | 'FAULTY' | 'DEGRADED' | 'BLOCKED_PARTS';
export type SpaceKind = 'CLASSROOM' | 'LAB' | 'CANTEEN' | 'BILL_BOT';
export type ResourceType = 'ROOM' | 'STAFF' | 'WORK_ORDER' | 'INVENTORY';

export interface TwinSpace {
  code: string;
  kind: SpaceKind;
  name?: string;
  block?: string;
  floor?: number;
  visual_state: VisualState;
  is_occupied_now: boolean;
  is_home_class_in_lab?: boolean;
  current_class_code?: string | null;
  current_student_count?: number | null;
  room_capacity?: number;
  active_fault_count: number;
  active_ticket_id?: string | null;
  sla_breach_state?: 'ON_TRACK' | 'WARNING_75' | 'BREACHED_100' | 'PAUSED' | null;
  has_active_lock: boolean;
  queue_count?: number;
  rerouted_to_bot_code?: string | null;
  paper_percent?: number;
}

export interface TwinOverview {
  spaces: TwinSpace[];
  generated_at?: string;
}

export interface CampusClock {
  day_of_week: 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI';
  current_time: string;
  active_period: number | null;
  minutes_remaining: number | null;
  is_break?: boolean;
}

export interface PeriodCard {
  period_number: number | null;
  time_label: string;
  minutes_remaining?: number;
  class_code?: string | null;
  department?: string;
  year?: number;
  section?: string;
  student_strength?: number;
  room_capacity?: number;
  subject_title?: string;
  session_type?: string;
  faculty_name?: string;
  location_status?: string;
  is_relocated?: boolean;
  relocated_from_code?: string;
  relocated_to_code?: string;
  away_in_lab_code?: string;
}

export interface Asset {
  id?: string;
  asset_code: string;
  asset_type: string;
  slot_index: number;
  status: 'OK' | 'DEGRADED' | 'FAULTY';
  paper_percent?: number;
}

export interface ComplaintComment {
  id: string;
  body: string;
  public_author_label: string;
  is_anonymous: boolean;
  created_at: string;
}

export interface Complaint {
  id: string;
  ticket_number: string;
  space_code: string;
  title?: string;
  description: string;
  category: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: string;
  moderation_status?: string;
  public_reporter_label: string;
  is_anonymous: boolean;
  photo_url?: string | null;
  affected_upvote_count: number;
  target_assets?: string[];
  parent_complaint_id?: string | null;
  created_at: string;
  comments?: ComplaintComment[];
  vault_token?: string | null;
}

export interface WorkOrder {
  id: string;
  work_order_number: string;
  complaint_id?: string;
  space_code: string;
  title?: string;
  description?: string;
  status: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED_PARTS' | 'RESOLVED' | 'CLOSED';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  priority_score?: number;
  required_skill: string;
  required_risk_clearance: string;
  assigned_staff_code?: string | null;
  assigned_staff_name?: string | null;
  reassignment_count?: number;
  last_reassignment_reason?: string;
  required_parts?: PartRequest[];
  created_at: string;
}

export interface Incident {
  id: string;
  incident_number: string;
  title: string;
  correlation_type: 'DISTRIBUTION_BOARD' | 'VERTICAL_RISER' | 'CHRONIC_ASSET' | 'MANUAL';
  root_cause?: string;
  distribution_board_code?: string;
  ai_summary_text: string;
  affected_space_codes: string[];
  affected_class_count?: number;
  affected_student_count?: number;
  chronic_replacement_advised?: boolean;
  status: string;
  sla_deadline?: string;
  complaints?: Complaint[];
  created_at: string;
}

export interface SlaClock {
  id: string;
  work_order_id: string;
  work_order_number?: string;
  space_code?: string;
  priority?: string;
  target_minutes: number;
  elapsed_active_minutes: number;
  remaining_minutes: number;
  progress_percent: number;
  breach_state: 'ON_TRACK' | 'WARNING_75' | 'BREACHED_100';
  is_paused: boolean;
  pause_reason?: string | null;
  current_escalation_tier: number;
  deadline_at?: string;
  escalation_log?: EscalationEvent[];
}

export interface EscalationEvent {
  id?: string;
  tier: number;
  recipient: string;
  channel: string;
  message: string;
  created_at: string;
}

export interface SpaceDetail {
  code: string;
  alias_code?: string;
  kind: SpaceKind;
  name?: string;
  block?: string;
  floor?: number;
  distribution_board_code?: string;
  visual_state: VisualState;
  home_class_code?: string;
  home_student_count?: number;
  active_lock?: ResourceLock | null;
  period_cards: {
    previous_period: PeriodCard | null;
    current_period: PeriodCard | null;
    next_period: PeriodCard | null;
  };
  full_day_timeline: PeriodCard[];
  assets: Asset[];
  active_complaints: Complaint[];
  correlated_incident?: Incident | null;
  active_work_order?: WorkOrder | null;
  sla_clock?: SlaClock | null;
  maintenance_history: MaintenanceRecord[];
}

export interface MaintenanceRecord {
  id: string;
  asset_code?: string;
  asset_type?: string;
  action: string;
  technician_name?: string;
  notes?: string;
  completed_at: string;
}

export interface ResourceLock {
  id: string;
  resource_type: ResourceType;
  resource_id: string;
  locked_by_user_id?: string;
  locked_by_name: string;
  locked_by_role: Role;
  acquired_seconds_ago?: number;
  expires_in_seconds: number;
  expires_at: string;
}

export interface RankedRoom {
  space_code: string;
  score: number;
  explanation: string;
  capacity?: number;
  score_breakdown?: Record<string, number | string>;
}

export interface UnavailableResource {
  code: string;
  name?: string;
  reason: string;
  details?: Record<string, string | number | boolean>;
}

export interface ConstraintCheck {
  rule: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface RoomConflictResult {
  faulted_space_code: string;
  affected_sessions: Array<{
    period_number: number;
    class_code: string;
    student_strength: number;
    subject_title: string;
    faculty_staff_code: string;
  }>;
  available_alternates: RankedRoom[];
  unavailable_spaces: UnavailableResource[];
  preflight_checks: ConstraintCheck[];
}

export interface StaffCandidate {
  staff_code: string;
  full_name: string;
  primary_skill: string;
  risk_clearance: string;
  current_active_jobs: number;
  max_concurrent_jobs: number;
  score: number;
  explanation?: string;
  score_breakdown: Record<string, number>;
}

export interface StaffRankingResult {
  work_order_id: string;
  available_ranked: StaffCandidate[];
  unavailable_staff: UnavailableResource[];
  preflight_checks: ConstraintCheck[];
}

export interface PartRequest {
  sku_code: string;
  quantity: number;
}

export interface PartsPreflightResult {
  work_order_id: string;
  requested_parts: PartRequest[];
  available_parts: InventoryItem[];
  unavailable_parts: UnavailableResource[];
  preflight_checks: ConstraintCheck[];
}

export interface InventoryItem {
  id?: string;
  sku_code: string;
  name: string;
  category: string;
  unit: string;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
  reorder_level: number;
  unit_cost_inr: number;
  supplier_name?: string;
  updated_at?: string;
}

export interface PurchaseRequest {
  id: string;
  pr_number: string;
  work_order_id?: string;
  work_order_number?: string;
  requested_by_user_id: string;
  requested_by_name: string;
  department_code: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'ORDERED' | 'RECEIVED' | 'REJECTED';
  total_cost_inr: number;
  items: Array<PartRequest & { unit_cost_inr?: number; item_name?: string }>;
  override_reason?: string;
  approvals?: Array<{ role: Role; approver_name: string; approved_at: string }>;
  created_at: string;
}

export interface ApprovalPreflight {
  purchase_request_id: string;
  can_approve: boolean;
  checks: ConstraintCheck[];
}

export interface ModerationItem {
  id: string;
  complaint_id?: string;
  submitted_text: string;
  moderation_status: 'HELD_ABUSIVE' | 'HELD_HARMFUL';
  moderation_reason: string;
  public_reporter_label: string;
  space_code?: string;
  vault_token?: string;
  is_anonymous: boolean;
  created_at: string;
}

export interface NotificationLog {
  id: string;
  channel: 'WEBHOOK' | 'EMAIL' | 'SMS';
  recipient: string;
  subject?: string;
  payload: string | Record<string, unknown>;
  status: string;
  related_resource_id?: string;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  sequence_number: number;
  timestamp: string;
  actor_email: string;
  actor_role: Role;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: 'ALLOWED' | 'REJECTED' | 'OVERRIDE' | 'BREAK_GLASS' | 'AUTO_REASSIGNED';
  rule_fired?: string | null;
  reason?: string | null;
  prev_hash: string;
  row_hash: string;
}

export interface AuditVerification {
  verified: boolean;
  total_entries: number;
  head_hash: string;
  invalid_sequence_number?: number;
}

export interface TimetableSlot {
  id?: string;
  day_of_week: string;
  period_number: number;
  time_label?: string;
  class_code: string;
  department?: string;
  year?: number;
  section?: string;
  student_strength?: number;
  subject_title: string;
  session_type: 'THEORY' | 'LAB';
  faculty_name?: string;
  home_room_code: string;
  effective_space_code: string;
  lab_code?: string;
  is_relocated?: boolean;
  relocated_from_code?: string;
}

export interface TimetableValidation {
  valid: boolean;
  total_slots: number;
  constraint_results: {
    one_lab_per_day_per_class: boolean;
    zero_lab_collisions: boolean;
    zero_room_collisions: boolean;
    zero_staff_collisions: boolean;
    vacant_home_rooms_per_period: number;
  };
}

export interface ApiErrorBody {
  detail?: string | { message?: string; rule_fired?: string; checks?: ConstraintCheck[]; [key: string]: unknown };
  locked_by_name?: string;
  locked_by_role?: Role;
  acquired_seconds_ago?: number;
  expires_in_seconds?: number;
  rule_fired?: string;
  checks?: ConstraintCheck[];
  [key: string]: unknown;
}
