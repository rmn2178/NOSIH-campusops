import { supabase, unwrap } from './client';

export const rpc = {
  searchDirectory: (query: string, limit = 8) =>
    supabase.rpc('rpc_search_directory', { p_query: query, p_limit: limit }).then(unwrap),

  inspector: (space: string) =>
    supabase.rpc('rpc_get_space_twin_inspector', { p_space_input: space }).then(unwrap),

  twinOverview: () => supabase.rpc('rpc_twin_overview').then(unwrap),

  submitComplaint: (payload: Record<string, unknown>) =>
    supabase.rpc('rpc_submit_complaint', { p_payload: payload }).then(unwrap),

  listComplaints: (filters: {
    zone?: string;
    status?: string | null;
    category?: string | null;
    mine?: boolean;
    limit?: number;
  }) =>
    supabase
      .rpc('rpc_list_complaints', {
        p_zone: filters.zone ?? 'ALL',
        p_status: filters.status ?? null,
        p_category: filters.category ?? null,
        p_my_department: filters.mine ?? false,
        p_limit: filters.limit ?? 100,
      })
      .then(unwrap),

  getComplaint: (id: number) => supabase.rpc('rpc_get_complaint', { p_complaint_id: id }).then(unwrap),

  postComment: (payload: Record<string, unknown>) =>
    supabase.rpc('rpc_post_comment', { p_payload: payload }).then(unwrap),

  supplement: (complaintId: number, answers: Record<string, unknown>) =>
    supabase
      .rpc('rpc_supplement_complaint', { p_complaint_id: complaintId, p_answers: answers })
      .then(unwrap),

  confirmAffected: (complaintId: number) =>
    supabase
      .rpc('rpc_confirm_affected', { p_complaint_id: complaintId, p_voter_hash: '' })
      .then(unwrap),

  claimLock: (type: string, id: string, email: string, name: string, role: string, ttl = 300) =>
    supabase
      .rpc('rpc_claim_resource_lock', {
        p_resource_type: type,
        p_resource_id: id,
        p_actor_email: email,
        p_actor_name: name,
        p_actor_role: role,
        p_ttl_seconds: ttl,
      })
      .then(unwrap),

  relocationCandidates: (room: string, day: string, period: number) =>
    supabase
      .rpc('rpc_get_room_relocation_candidates', {
        p_faulted_room_code: room,
        p_day: day,
        p_period: period,
      })
      .then(unwrap),

  executeRelocation: (
    faulted: string,
    target: string,
    day: string,
    period: number,
    email: string,
    role: string,
  ) =>
    supabase
      .rpc('rpc_execute_room_relocation', {
        p_faulted_room_code: faulted,
        p_target_room_code: target,
        p_day: day,
        p_period: period,
        p_actor_email: email,
        p_actor_role: role,
      })
      .then(unwrap),

  createBooking: (params: {
    spaceCode: string;
    startsAt: string;
    endsAt: string;
    purpose: string;
    classCode?: string | null;
    email: string;
    requestKey?: string | null;
  }) =>
    supabase
      .rpc('rpc_create_booking', {
        p_space_code: params.spaceCode,
        p_starts_at: params.startsAt,
        p_ends_at: params.endsAt,
        p_purpose: params.purpose,
        p_class_code: params.classCode ?? null,
        p_actor_email: params.email,
        p_request_key: params.requestKey ?? null,
      })
      .then(unwrap),

  cancelBooking: (bookingId: number, email: string) =>
    supabase
      .rpc('rpc_cancel_booking', { p_booking_id: bookingId, p_actor_email: email })
      .then(unwrap),

  listBookings: (from: string, limit = 50) =>
    supabase.rpc('rpc_list_bookings', { p_from: from, p_limit: limit }).then(unwrap),

  roomOccupancy: (spaceCode: string, from: string, to: string) =>
    supabase
      .rpc('rpc_get_room_occupancy', { p_space_code: spaceCode, p_from: from, p_to: to })
      .then(unwrap),

  rankStaff: (workOrderId: number) =>
    supabase.rpc('rpc_rank_staff_for_work_order', { p_work_order_id: workOrderId }).then(unwrap),

  assignStaff: (
    workOrderId: number,
    staffCode: string,
    email: string,
    role: string,
    auto = false,
    reason: string | null = null,
  ) =>
    supabase
      .rpc('rpc_assign_or_rebalance_staff', {
        p_work_order_id: workOrderId,
        p_staff_code: staffCode,
        p_actor_email: email,
        p_actor_role: role,
        p_is_auto_rebalance: auto,
        p_rebalance_reason: reason,
      })
      .then(unwrap),

  assignStaffChecked: (
    workOrderId: number,
    staffCode: string,
    email: string,
    role: string,
    expected: { assigned_staff_code: string | null; reassignment_count: number },
  ) =>
    supabase
      .rpc('rpc_assign_or_rebalance_staff_checked', {
        p_work_order_id: workOrderId,
        p_staff_code: staffCode,
        p_actor_email: email,
        p_actor_role: role,
        p_expected: expected,
      })
      .then(unwrap),

  reserveParts: (workOrderId: number, parts: Array<{ sku_code: string; qty: number }>, email: string, role: string) =>
    supabase
      .rpc('rpc_reserve_parts_for_work_order', {
        p_work_order_id: workOrderId,
        p_parts_json: parts,
        p_actor_email: email,
        p_actor_role: role,
      })
      .then(unwrap),

  decidePurchase: (
    prId: number,
    decision: string,
    email: string,
    role: string,
    override: boolean,
    reason: string | null,
    countersign: string | null,
  ) =>
    supabase
      .rpc('rpc_decide_purchase_request', {
        p_pr_id: prId,
        p_decision: decision,
        p_actor_user_id: null,
        p_actor_email: email,
        p_actor_role: role,
        p_is_override: override,
        p_override_reason: reason,
        p_countersign_email: countersign,
      })
      .then(unwrap),

  receiveStock: (prId: number, email: string) =>
    supabase
      .rpc('rpc_receive_purchase_request_stock', { p_pr_id: prId, p_actor_email: email })
      .then(unwrap),

  breakGlass: (token: string, email: string, role: string, justification: string) =>
    supabase
      .rpc('rpc_break_glass_unseal_identity', {
        p_vault_token: token,
        p_actor_email: email,
        p_actor_role: role,
        p_justification: justification,
      })
      .then(unwrap),

  supaReleaseLock: (lockId: number, email: string) =>
    supabase
      .rpc('rpc_release_resource_lock', { p_lock_id: lockId, p_actor_email: email })
      .then(unwrap),

  partsPreflight: (workOrderId: number) =>
    supabase.rpc('rpc_parts_preflight', { p_work_order_id: workOrderId }).then(unwrap),

  purchasePreflight: (prId: number, email: string) =>
    supabase.rpc('rpc_purchase_preflight', { p_pr_id: prId, p_actor_email: email }).then(unwrap),

  completeWorkOrder: (workOrderId: number, notes: string, email: string) =>
    supabase
      .rpc('rpc_complete_work_order', {
        p_work_order_id: workOrderId,
        p_notes: notes,
        p_actor_email: email,
      })
      .then(unwrap),

  shiftChange: (staffCode: string, onShift: boolean, email: string) =>
    supabase
      .rpc('rpc_trigger_staff_shift_change', {
        p_staff_code: staffCode,
        p_new_on_shift: onShift,
        p_actor_email: email,
      })
      .then(unwrap),

  timetableValidate: () => supabase.rpc('rpc_timetable_validate').then(unwrap),

  verifyAudit: () => supabase.rpc('rpc_verify_audit_chain').then(unwrap),

  aiChat: (
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    portal: 'COMPLAINT' | 'ADMIN' = 'COMPLAINT',
    spaceCode: string | null = null,
    conversationId: string | null = null,
  ) =>
    supabase
      .rpc('rpc_ai_chat', {
        p_messages: messages,
        p_portal: portal,
        p_space_code: spaceCode,
        p_conversation_id: conversationId,
      })
      .then(unwrap),

  aiChatHistory: (conversationId: string | null = null, limit = 50) =>
    supabase
      .rpc('rpc_ai_chat_history', { p_conversation_id: conversationId, p_limit: limit })
      .then(unwrap),

  setClock: (day: string, period: number) =>
    supabase.rpc('rpc_set_clock', { p_day: day, p_period: period }).then(unwrap),

  updateComplaintStatus: (id: number, status: string, email: string) =>
    supabase
      .rpc('rpc_update_complaint_status', {
        p_complaint_id: id,
        p_status: status,
        p_actor_email: email,
      })
      .then(unwrap),
};

export async function invokeIntake(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('intake-complaint', { body });
  if (error) throw error;
  return data;
}

export async function invokeComment(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('post-comment', { body });
  if (error) throw error;
  return data;
}

export async function invokeSupplement(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('supplement-missing-info', { body });
  if (error) throw error;
  return data;
}
