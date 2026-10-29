export type UserRole = "STUDENT" | "FACULTY" | "LAB_STAFF" | "MAINTENANCE" | "INCIDENT_MANAGER" | "FACILITIES_ADMIN" | "PROCUREMENT_APPROVER" | "SYSTEM_ADMIN";
export type ComplaintStatus = "OPEN" | "TRIAGED" | "IN_PROGRESS" | "BLOCKED_PARTS" | "RESOLVED" | "MERGED_DUPLICATE";
export type Urgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SessionProfile {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
  department_code: string | null;
  year_number: number | null;
  class_code: string | null;
  home_room_code?: string | null;
  section_letter?: string | null;
}

export interface Complaint {
  id: number;
  ticket_number: string;
  space_type: string;
  space_code: string;
  title: string;
  description: string;
  image_url: string | null;
  is_anonymous: boolean;
  public_reporter_label: string;
  moderation_status: string;
  moderation_reason?: string | null;
  category: string | null;
  urgency: Urgency;
  status: ComplaintStatus;
  parent_complaint_id: number | null;
  affected_upvote_count: number;
  ai_extracted: Record<string, unknown>;
  missing_info_questions: string[];
  missing_info_answers: Record<string, string>;
  created_at: string;
}

export interface ComplaintComment {
  id: number;
  complaint_id: number;
  body: string;
  is_anonymous: boolean;
  public_author_label: string;
  author_role_badge: string;
  moderation_status: string;
  created_at: string;
}

export interface WorkOrder {
  id: number;
  wo_number: string;
  complaint_id: number | null;
  space_code: string;
  target_asset_codes: string[];
  required_skill: string;
  required_risk_clearance: string;
  priority_score: number;
  assigned_staff_code: string | null;
  status: string;
}

export interface InventoryItem {
  sku_code: string;
  part_name: string;
  category: string;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
  reorder_threshold: number;
  unit_cost_inr: number;
}

export interface PurchaseRequest {
  id: number;
  pr_number: string;
  department_code: string;
  sku_code: string;
  quantity_requested: number;
  total_cost_inr: number;
  requested_by_user_id: number;
  status: string;
  requires_dual_approval: boolean;
}
