/**
 * NOSIH complaint portal API, backed by Supabase.
 *
 * Auth uses Supabase Auth (email + password). Complaints, comments, voting and
 * space inspection go through SECURITY DEFINER RPCs; photos go to the
 * complaint-evidence Storage bucket. The AI intake Edge Function is used when
 * deployed and falls back to the deterministic SQL pipeline.
 */

import {
  invokeComment,
  invokeIntake,
  invokeSupplement,
  rpc,
  signIn,
  signUp,
  supabase,
} from '@nosih/supabase-client';

export const DEPARTMENTS = ['AI&DS', 'AIML', 'CSE', 'ECE', 'MECH', 'Cyber Security'] as const;
export type Department = (typeof DEPARTMENTS)[number];
export type AcademicRole = 'YEAR_1' | 'YEAR_2' | 'YEAR_3' | 'FACULTY_STAFF';
export type SpaceKind = 'CLASSROOM' | 'LAB' | 'CANTEEN' | 'BILL_BOT';
export type AssetStatus = 'OK' | 'DEGRADED' | 'FAULTY';
export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ComplaintStatus = 'OPEN' | 'IN_PROGRESS' | 'BLOCKED_PARTS' | 'RESOLVED';
export type ModerationStatus = 'APPROVED' | 'NEEDS_REWRITE' | 'HELD_ABUSIVE' | 'HELD_HARMFUL';
export type TwinState = 'HEALTHY' | 'FAULTY' | 'DEGRADED' | 'BLOCKED_PARTS';
export type SlotState = 'FREE' | 'CLASS' | 'EXAM' | 'BOOKING';

export interface ComplaintOfficer {
  staff_code: string;
  full_name: string;
  primary_skill: string;
  area: string;
  work_order_number?: string;
  work_order_status?: string;
  assigned_at?: string;
  assigned_jobs?: number;
  max_jobs?: number;
}

export interface RoomSlot {
  period_number: number;
  starts_at: string;
  ends_at: string;
  state: SlotState;
  label: string | null;
  owner: string | null;
  student_strength: number | null;
}

export interface BookableRoom {
  room_code: string;
  capacity: number;
  block: string;
  floor_number: number;
  slots: RoomSlot[];
}

export interface FacultyBooking {
  id: string;
  space_code: string;
  class_code?: string | null;
  purpose: string;
  starts_at: string;
  ends_at: string;
  status: 'ACTIVE' | 'CANCELLED';
  booked_by_name?: string | null;
  department_code?: string | null;
}

export interface BookingConflict {
  kind: 'CLASS' | 'EXAM' | 'BOOKING';
  label: string;
  owner?: string | null;
  class_code?: string | null;
  period_number?: number;
  student_strength?: number;
  starts_at: string;
  ends_at: string;
}

export interface BookingAlternative {
  room_code: string;
  capacity: number;
}

export interface BookingOutcome {
  success: boolean;
  error?: string;
  reason?: string;
  booking_id?: string;
  space_code?: string;
  starts_at?: string;
  ends_at?: string;
  status?: string;
  idempotent?: boolean;
  already_cancelled?: boolean;
  conflicts?: BookingConflict[];
  alternatives?: BookingAlternative[];
  student_strength?: number;
  room_capacity?: number;
  visual_state?: string;
}

export interface SessionProfile {
  id: string;
  email: string;
  full_name: string;
  department: Department;
  academic_role: AcademicRole;
  year_number: 1 | 2 | 3 | null;
  section: string | null;
  home_room_code: string | null;
  class_code?: string | null;
  role: 'STUDENT' | 'FACULTY' | 'STAFF';
}

export interface LoginRequest {
  email: string;
  department: Department;
  academic_role: AcademicRole;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'bearer';
  user: SessionProfile;
}

export interface DirectoryEntry {
  email: string;
  full_name: string;
  department: Department;
  academic_role: AcademicRole;
  year_number: 1 | 2 | 3 | null;
}

export interface AssetTarget {
  asset_code: string;
  asset_type: string;
  slot_index: number;
}

export interface SpaceAsset extends AssetTarget {
  status: AssetStatus;
  label?: string;
}

export interface PeriodContext {
  period_number: number | null;
  time_label?: string;
  class_code?: string | null;
  subject_title?: string | null;
  faculty_name?: string | null;
  student_strength?: number | null;
  away_in_lab_code?: string | null;
  location_status?: string | null;
}

export interface SpaceDetails {
  code: string;
  name?: string;
  kind: SpaceKind;
  block?: string | null;
  floor?: number | null;
  visual_state: TwinState;
  current_period?: PeriodContext | null;
  assets: SpaceAsset[];
}

export interface PhotoUpload {
  id: string;
  url: string;
  content_type: string;
  size_bytes: number;
}

export interface CreateComplaintRequest {
  space_code: string;
  description: string;
  is_anonymous: boolean;
  target_assets: AssetTarget[];
  photo_upload_id?: string;
  client_timestamp: string;
}

export interface FirstResponse {
  space_code: string;
  block_floor?: string | null;
  target_assets: AssetTarget[];
  category: string;
  urgency: Urgency;
  sla_target_minutes: number;
  missing_info_questions: string[];
  merged_duplicate: boolean;
  parent_complaint_id?: string | null;
  parent_ticket_number?: string | null;
  affected_count?: number | null;
}

export interface Complaint {
  id: string;
  ticket_number: string;
  space_code: string;
  space_name?: string | null;
  space_kind: SpaceKind;
  description: string;
  category: string;
  urgency: Urgency;
  status: ComplaintStatus;
  twin_state: TwinState;
  reporter_label: string;
  is_anonymous: boolean;
  reporter_department?: Department | null;
  photo_url?: string | null;
  target_assets: AssetTarget[];
  affected_count: number;
  viewer_has_voted: boolean;
  comment_count: number;
  sla_target_minutes: number;
  sla_due_at?: string | null;
  sla_breach_state?: 'ON_TRACK' | 'WARNING_75' | 'BREACHED_100' | 'PAUSED' | null;
  officer?: ComplaintOfficer | null;
  created_at: string;
  updated_at: string;
  parent_complaint_id?: string | null;
  parent_ticket_number?: string | null;
  first_response?: FirstResponse | null;
}

export interface ModerationRejectedResponse {
  moderation_status: 'NEEDS_REWRITE' | 'HELD_ABUSIVE' | 'HELD_HARMFUL';
  message: string;
  suggested_polite_rewrite?: string | null;
}

export interface ComplaintApprovedResponse {
  moderation_status: 'APPROVED';
  complaint: Complaint;
  first_response: FirstResponse;
}

export type ComplaintSubmissionResponse = ComplaintApprovedResponse | ModerationRejectedResponse;

export interface SupplementAnswer {
  question: string;
  answer: string;
}

export interface SupplementRequest {
  answers: SupplementAnswer[];
}

export interface SupplementResponse {
  complaint: Complaint;
  first_response: FirstResponse;
}

export interface ComplaintComment {
  id: string;
  complaint_id: string;
  body: string;
  author_label: string;
  is_anonymous: boolean;
  created_at: string;
}

export interface CommentApprovedResponse {
  moderation_status: 'APPROVED';
  comment: ComplaintComment;
}

export type CommentSubmissionResponse = CommentApprovedResponse | ModerationRejectedResponse;

export interface ComplaintFilters {
  zone?: 'ALL' | 'BLOCK_A' | 'BLOCK_B' | 'BLOCK_C' | 'LABS' | 'CANTEENS' | 'BILL_BOTS';
  status?: ComplaintStatus | 'ACTIVE' | 'ALL';
  category?: string;
  my_department?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const DEPARTMENT_CODES: Record<Department, string> = {
  'AI&DS': 'AIDS',
  AIML: 'AIML',
  CSE: 'CSE',
  ECE: 'ECE',
  MECH: 'MECH',
  'Cyber Security': 'CYBER',
};

const DEPARTMENT_LABELS: Record<string, Department> = {
  AIDS: 'AI&DS',
  AIML: 'AIML',
  CSE: 'CSE',
  ECE: 'ECE',
  MECH: 'MECH',
  CYBER: 'Cyber Security',
};

export function setApiAccessToken(_token: string | null) {
  // Supabase Auth owns the session; kept for the existing Zustand store.
}

export async function restoreSession(): Promise<LoginResponse | null> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  try {
    const profile = mapProfile(await loadProfile());
    return {
      access_token: data.session.access_token,
      token_type: 'bearer',
      user: profile,
    };
  } catch {
    return null;
  }
}

/** Local Supabase session read (no network). */
export async function readSessionToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

let profileInFlight: Promise<SessionProfile> | null = null;

/** Refresh the signed-in profile without blocking the first paint. */
export async function readProfile(): Promise<SessionProfile> {
  if (!profileInFlight) {
    profileInFlight = (async () => mapProfile(await loadProfile()))().finally(() => {
      profileInFlight = null;
    });
  }
  return profileInFlight;
}

function mapProfile(raw: Record<string, unknown>): SessionProfile {
  const year = typeof raw.year_number === 'number' ? raw.year_number : null;
  const isStudent = raw.role === 'STUDENT';
  return {
    id: String(raw.id),
    email: String(raw.email),
    full_name: String(raw.full_name),
    department: DEPARTMENT_LABELS[String(raw.department_code)] ?? 'CSE',
    academic_role: isStudent && year ? (`YEAR_${year}` as AcademicRole) : 'FACULTY_STAFF',
    year_number: isStudent && year ? (year as 1 | 2 | 3) : null,
    section: (raw.section as string) ?? null,
    home_room_code: (raw.home_room_code as string) ?? null,
    class_code: (raw.class_code as string) ?? (raw.assigned_class_code as string) ?? null,
    role: isStudent ? 'STUDENT' : raw.role === 'FACULTY' ? 'FACULTY' : 'STAFF',
  };
}

async function loadProfile(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('rpc_my_profile');
  if (error || !data) throw new ApiError(error?.message ?? 'Unable to load your profile', 401);
  return data as Record<string, unknown>;
}

export function mapComplaint(raw: Record<string, unknown>): Complaint {
  return {
    id: String(raw.id),
    ticket_number: String(raw.ticket_number),
    space_code: String(raw.space_code),
    space_name: (raw.space_name as string) ?? null,
    space_kind: (raw.space_kind as SpaceKind) ?? 'CLASSROOM',
    description: String(raw.description),
    category: String(raw.category ?? 'ELECTRICAL'),
    urgency: (raw.urgency as Urgency) ?? 'MEDIUM',
    status: (raw.status as ComplaintStatus) ?? 'OPEN',
    twin_state: (raw.twin_state as TwinState) ?? 'DEGRADED',
    reporter_label: String(raw.reporter_label ?? 'Campus member'),
    is_anonymous: Boolean(raw.is_anonymous),
    reporter_department: raw.reporter_department
      ? DEPARTMENT_LABELS[String(raw.reporter_department)] ?? null
      : null,
    photo_url: (raw.photo_url as string) ?? null,
    target_assets: Array.isArray(raw.target_assets)
      ? (raw.target_assets as Array<Record<string, unknown>>).map((asset) => ({
          asset_code: String(asset.asset_code),
          asset_type: String(asset.asset_type),
          slot_index: Number(asset.slot_index ?? 1),
        }))
      : [],
    affected_count: Number(raw.affected_count ?? 0),
    viewer_has_voted: Boolean(raw.viewer_has_voted),
    comment_count: Number(raw.comment_count ?? 0),
    sla_target_minutes: Number(raw.sla_target_minutes ?? 1440),
    sla_due_at: (raw.sla_due_at as string) ?? null,
    sla_breach_state: (raw.sla_breach_state as Complaint['sla_breach_state']) ?? null,
    officer: raw.officer && typeof raw.officer === 'object'
      ? {
          staff_code: String((raw.officer as Record<string, unknown>).staff_code ?? ''),
          full_name: String((raw.officer as Record<string, unknown>).full_name ?? ''),
          primary_skill: String((raw.officer as Record<string, unknown>).primary_skill ?? ''),
          area: String((raw.officer as Record<string, unknown>).area ?? ''),
          work_order_number: (raw.officer as Record<string, unknown>).work_order_number
            ? String((raw.officer as Record<string, unknown>).work_order_number)
            : undefined,
          work_order_status: (raw.officer as Record<string, unknown>).work_order_status
            ? String((raw.officer as Record<string, unknown>).work_order_status)
            : undefined,
          assigned_at: (raw.officer as Record<string, unknown>).assigned_at
            ? String((raw.officer as Record<string, unknown>).assigned_at)
            : undefined,
          assigned_jobs: Number((raw.officer as Record<string, unknown>).assigned_jobs ?? 0),
          max_jobs: Number((raw.officer as Record<string, unknown>).max_jobs ?? 0),
        }
      : null,
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at ?? raw.created_at),
    parent_complaint_id: raw.parent_complaint_id ? String(raw.parent_complaint_id) : null,
    parent_ticket_number: (raw.parent_ticket_number as string) ?? null,
    first_response: (raw.first_response as FirstResponse) ?? null,
  };
}

export function mapComment(raw: Record<string, unknown>): ComplaintComment {
  return {
    id: String(raw.id),
    complaint_id: String(raw.complaint_id),
    body: String(raw.body),
    author_label: String(raw.author_label ?? raw.public_author_label ?? 'Campus member'),
    is_anonymous: Boolean(raw.is_anonymous),
    created_at: String(raw.created_at),
  };
}

function mapSpace(raw: Record<string, unknown>): SpaceDetails {
  const space = (raw.space as Record<string, unknown>) ?? {};
  const cards = (raw.period_cards as Record<string, unknown>) ?? {};
  const current = cards.current_period as Record<string, unknown> | null;
  return {
    code: String(raw.code ?? space.code),
    name: (space.name as string) ?? undefined,
    kind: ((space.kind as SpaceKind) ?? 'CLASSROOM'),
    block: (space.block as string) ?? null,
    floor: (space.floor as number) ?? null,
    visual_state: ((space.visual_state as TwinState) ?? 'HEALTHY'),
    current_period: current
      ? {
          period_number: (current.period_number as number) ?? null,
          time_label: current.time_label as string,
          class_code: (current.class_code as string) ?? null,
          subject_title: (current.subject_title as string) ?? null,
          faculty_name: (current.faculty_name as string) ?? null,
          student_strength: (current.student_strength as number) ?? null,
          away_in_lab_code: (current.away_in_lab_code as string) ?? null,
          location_status: (current.location_status as string) ?? null,
        }
      : null,
    assets: Array.isArray(raw.assets)
      ? (raw.assets as Array<Record<string, unknown>>).map((asset) => ({
          asset_code: String(asset.asset_code),
          asset_type: String(asset.asset_type),
          slot_index: Number(asset.slot_index ?? 1),
          status: (asset.status as AssetStatus) ?? 'OK',
          label: (asset.name as string) ?? undefined,
        }))
      : [],
  };
}

let complaintsInFlight: { key: string; promise: Promise<Complaint[]> } | null = null;

function mapBookingOutcome(raw: Record<string, unknown>): BookingOutcome {
  return {
    success: Boolean(raw.success),
    error: raw.error ? String(raw.error) : undefined,
    reason: raw.reason ? String(raw.reason) : undefined,
    booking_id: raw.booking_id ? String(raw.booking_id) : undefined,
    space_code: raw.space_code ? String(raw.space_code) : undefined,
    starts_at: raw.starts_at ? String(raw.starts_at) : undefined,
    ends_at: raw.ends_at ? String(raw.ends_at) : undefined,
    status: raw.status ? String(raw.status) : undefined,
    idempotent: Boolean(raw.idempotent),
    already_cancelled: Boolean(raw.already_cancelled),
    conflicts: Array.isArray(raw.conflicts)
      ? (raw.conflicts as Array<Record<string, unknown>>).map((conflict) => ({
          kind: String(conflict.kind ?? 'CLASS') as BookingConflict['kind'],
          label: String(conflict.label ?? ''),
          owner: conflict.owner ? String(conflict.owner) : null,
          class_code: conflict.class_code ? String(conflict.class_code) : null,
          period_number: conflict.period_number ? Number(conflict.period_number) : undefined,
          student_strength: conflict.student_strength ? Number(conflict.student_strength) : undefined,
          starts_at: String(conflict.starts_at ?? ''),
          ends_at: String(conflict.ends_at ?? ''),
        }))
      : undefined,
    alternatives: Array.isArray(raw.alternatives)
      ? (raw.alternatives as Array<Record<string, unknown>>).map((alternative) => ({
          room_code: String(alternative.room_code),
          capacity: Number(alternative.capacity ?? 0),
        }))
      : undefined,
    student_strength: raw.student_strength ? Number(raw.student_strength) : undefined,
    room_capacity: raw.room_capacity ? Number(raw.room_capacity) : undefined,
    visual_state: raw.visual_state ? String(raw.visual_state) : undefined,
  };
}

export const api = {
  login: async (body: LoginRequest): Promise<LoginResponse> => {
    const email = body.email.trim().toLowerCase();
    const role = body.academic_role === 'FACULTY_STAFF' ? 'FACULTY' : 'STUDENT';
    const year = body.academic_role.startsWith('YEAR_')
      ? Number(body.academic_role.slice(-1))
      : null;

    let result = await signIn(email, body.password);
    if (result.error) {
      const message = result.error.message.toLowerCase();
      if (!message.includes('invalid login')) {
        throw new ApiError(result.error.message, 400);
      }
      const created = await signUp(email, body.password, {
        full_name: email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        role,
        department_code: DEPARTMENT_CODES[body.department],
        year_number: year,
      });
      if (created.error) throw new ApiError(created.error.message, 400);
      if (!created.data.session) {
        throw new ApiError('Account created. Confirm your email, then sign in again.', 401);
      }
      result = { data: created.data, error: null } as unknown as typeof result;
    }

    const profile = mapProfile(await loadProfile());
    const { data } = await supabase.auth.getSession();
    return {
      access_token: data.session?.access_token ?? '',
      token_type: 'bearer',
      user: profile,
    };
  },

  searchDirectory: async (query: string, _signal?: AbortSignal): Promise<DirectoryEntry[]> => {
    const rows = (await rpc.searchDirectory(query, 8)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      email: String(row.email),
      full_name: String(row.full_name),
      department: DEPARTMENT_LABELS[String(row.department)] ?? (String(row.department) as Department),
      academic_role: (String(row.academic_role) as AcademicRole) ?? 'FACULTY_STAFF',
      year_number: (row.year_number as 1 | 2 | 3 | null) ?? null,
    }));
  },

  getSpace: async (spaceCode: string, _signal?: AbortSignal): Promise<SpaceDetails> => {
    const raw = (await rpc.inspector(spaceCode)) as Record<string, unknown>;
    if (raw.error) throw new ApiError(String(raw.error), 404, raw);
    return mapSpace(raw);
  },

  uploadPhoto: async (file: File): Promise<PhotoUpload> => {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) throw new ApiError('Sign in before uploading evidence', 401);
    const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `${userData.user.id}/${crypto.randomUUID()}.${extension}`;
    const { error } = await supabase.storage
      .from('complaint-evidence')
      .upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw new ApiError(error.message, 400);
    const { data } = supabase.storage.from('complaint-evidence').getPublicUrl(path);
    return {
      id: data.publicUrl,
      url: data.publicUrl,
      content_type: file.type,
      size_bytes: file.size,
    };
  },

  createComplaint: async (body: CreateComplaintRequest): Promise<ComplaintSubmissionResponse> => {
    const imageUrl = body.photo_upload_id?.startsWith('http') ? body.photo_upload_id : null;

    let data: Record<string, unknown>;
    try {
      data = (await invokeIntake({
        space_code: body.space_code,
        description: body.description,
        is_anonymous: body.is_anonymous,
        image_url: imageUrl,
      })) as Record<string, unknown>;
    } catch {
      const profile = await loadProfile();
      data = (await rpc.submitComplaint({
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        department_code: profile.department_code,
        year_number: profile.year_number,
        is_anonymous: body.is_anonymous,
        space_code: body.space_code,
        description: body.description,
        image_url: imageUrl,
        target_assets: body.target_assets.map((asset) => ({
          asset_code: asset.asset_code,
          asset_type: asset.asset_type,
        })),
        source_channel: 'WEB_PORTAL',
      })) as Record<string, unknown>;
    }

    if (data.error) throw new ApiError(String(data.error), 400, data);
    const status = String(data.moderation_status ?? 'APPROVED') as ModerationStatus;
    if (status !== 'APPROVED') {
      return {
        moderation_status: status,
        message: String(data.error ?? data.moderation_reason ?? 'Held for moderation'),
        suggested_polite_rewrite: (data.suggested_rewrite as string) ?? null,
      };
    }
    const complaint = mapComplaint(data.complaint as Record<string, unknown>);
    complaintsInFlight = null;
    return {
      moderation_status: 'APPROVED',
      complaint,
      first_response: (data.first_response as FirstResponse) ?? complaint.first_response!,
    };
  },

  supplementComplaint: async (complaintId: string, body: SupplementRequest): Promise<SupplementResponse> => {
    let data: Record<string, unknown>;
    try {
      data = (await invokeSupplement({
        complaint_id: Number(complaintId),
        answers: Object.fromEntries(body.answers.map((answer) => [answer.question, answer.answer])),
      })) as Record<string, unknown>;
    } catch {
      data = (await rpc.supplement(
        Number(complaintId),
        Object.fromEntries(body.answers.map((answer) => [answer.question, answer.answer])),
      )) as Record<string, unknown>;
    }
    const complaint = mapComplaint(data.complaint ? (data.complaint as Record<string, unknown>) : data);
    return { complaint, first_response: (data.first_response as FirstResponse) ?? complaint.first_response! };
  },

  listComplaints: (filters: ComplaintFilters, _signal?: AbortSignal): Promise<Complaint[]> => {
    const key = JSON.stringify([filters.zone, filters.status, filters.category, Boolean(filters.my_department)]);
    if (complaintsInFlight?.key === key) return complaintsInFlight.promise;
    let promise: Promise<Complaint[]>;
    promise = (async () => {
      const rows = (await rpc.listComplaints({
        zone: filters.zone ?? 'ALL',
        status: filters.status && filters.status !== 'ALL' ? filters.status : null,
        category: filters.category && filters.category !== 'ALL' ? filters.category : null,
        mine: Boolean(filters.my_department),
        limit: 10,
      })) as Array<Record<string, unknown>>;
      return rows.map(mapComplaint);
    })().finally(() => {
      if (complaintsInFlight?.promise === promise) complaintsInFlight = null;
    });
    complaintsInFlight = { key, promise };
    return promise;
  },

  getComplaint: async (complaintId: string): Promise<Complaint> => {
    const raw = (await rpc.getComplaint(Number(complaintId))) as Record<string, unknown>;
    if (raw.error) throw new ApiError(String(raw.error), 404, raw);
    return mapComplaint(raw);
  },

  confirmAffected: async (complaintId: string): Promise<Complaint> => {
    await rpc.confirmAffected(Number(complaintId));
    return api.getComplaint(complaintId);
  },

  listComments: async (complaintId: string): Promise<ComplaintComment[]> => {
    const { data, error } = await supabase
      .from('complaint_comments')
      .select('id,complaint_id,body,public_author_label,is_anonymous,created_at')
      .eq('complaint_id', Number(complaintId))
      .eq('moderation_status', 'APPROVED')
      .order('created_at', { ascending: true });
    if (error) throw new ApiError(error.message, 400);
    return (data ?? []).map(mapComment);
  },

  createComment: async (complaintId: string, body: string, isAnonymous: boolean): Promise<CommentSubmissionResponse> => {
    let data: Record<string, unknown>;
    try {
      data = (await invokeComment({
        complaint_id: Number(complaintId),
        body,
        is_anonymous: isAnonymous,
      })) as Record<string, unknown>;
    } catch {
      const profile = await loadProfile();
      data = (await rpc.postComment({
        complaint_id: Number(complaintId),
        email: profile.email,
        body,
        is_anonymous: isAnonymous,
      })) as Record<string, unknown>;
    }

    if (data.moderation_status && data.moderation_status !== 'APPROVED') {
      return {
        moderation_status: data.moderation_status as ModerationRejectedResponse['moderation_status'],
        message: String(data.error ?? 'Held for moderation'),
        suggested_polite_rewrite: data.suggested_polite_rewrite ? String(data.suggested_polite_rewrite) : null,
      };
    }
    return {
      moderation_status: 'APPROVED',
      comment: mapComment(data.comment as Record<string, unknown>),
    };
  },

  bookings: {
    rooms: async (date: string): Promise<BookableRoom[]> => {
      const rows = (await rpc.bookableRooms(date)) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        room_code: String(row.room_code),
        capacity: Number(row.capacity ?? 0),
        block: String(row.block ?? ''),
        floor_number: Number(row.floor_number ?? 0),
        slots: Array.isArray(row.slots)
          ? (row.slots as Array<Record<string, unknown>>).map((slot) => ({
              period_number: Number(slot.period_number ?? 0),
              starts_at: String(slot.starts_at),
              ends_at: String(slot.ends_at),
              state: (String(slot.state ?? 'FREE') as SlotState),
              label: slot.label ? String(slot.label) : null,
              owner: slot.owner ? String(slot.owner) : null,
              student_strength: slot.student_strength ? Number(slot.student_strength) : null,
            }))
          : [],
      }));
    },

    mine: async (): Promise<FacultyBooking[]> => {
      const from = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const rows = (await rpc.myBookings(from, 50)) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        space_code: String(row.space_code),
        class_code: row.class_code ? String(row.class_code) : null,
        purpose: String(row.purpose ?? 'Booked room'),
        starts_at: String(row.starts_at),
        ends_at: String(row.ends_at),
        status: (String(row.status ?? 'ACTIVE') as FacultyBooking['status']),
        booked_by_name: row.booked_by_name ? String(row.booked_by_name) : null,
        department_code: row.department_code ? String(row.department_code) : null,
      }));
    },

    create: async (payload: {
      spaceCode: string;
      startsAt: string;
      endsAt: string;
      purpose: string;
      classCode?: string | null;
      requestKey?: string | null;
    }): Promise<BookingOutcome> => {
      const profile = await loadProfile();
      const raw = (await rpc.createBooking({
        spaceCode: payload.spaceCode,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
        purpose: payload.purpose,
        classCode: payload.classCode ?? null,
        email: String(profile.email),
        requestKey: payload.requestKey ?? null,
      })) as Record<string, unknown>;
      return mapBookingOutcome(raw);
    },

    cancel: async (bookingId: number): Promise<BookingOutcome> => {
      const profile = await loadProfile();
      const raw = (await rpc.cancelBooking(bookingId, String(profile.email))) as Record<string, unknown>;
      return mapBookingOutcome(raw);
    },
  },
};
