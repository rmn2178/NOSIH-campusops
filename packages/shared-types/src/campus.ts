export type VisualState = "HEALTHY" | "DEGRADED" | "FAULTY" | "SAFETY_LOCK" | "BLOCKED_PARTS";
export type SpaceType = "ROOM" | "LAB" | "CANTEEN" | "BILL_BOT";
export type AssetStatus = "OK" | "DEGRADED" | "FAULTY" | "UNDER_MAINTENANCE";

export interface TwinSpace {
  code: string;
  space_type: SpaceType;
  name?: string;
  visual_state: VisualState;
  is_occupied_now: boolean;
  current_class_code: string | null;
  current_student_count: number;
  active_fault_count: number;
  sla_breach_state: string | null;
  has_active_lock: boolean;
  building_code?: string;
  floor_number?: number;
  x_pos: number;
  y_pos: number;
  z_pos: number;
}

export interface Asset {
  id: number;
  asset_code: string;
  name: string;
  asset_type: string;
  parent_space_type: SpaceType;
  parent_space_code: string;
  slot_index: number;
  status: AssetStatus;
  sku_code: string | null;
  failure_count_30d: number;
}

export interface PeriodCard {
  period_number: number | null;
  time_label: string;
  minutes_remaining?: number;
  class_code: string | null;
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

export interface SpaceInspector {
  code: string;
  space_type: SpaceType;
  visual_state: VisualState;
  distribution_board_code?: string;
  active_lock?: ResourceLockView | null;
  period_cards: {
    previous_period: PeriodCard | null;
    current_period: PeriodCard | null;
    next_period: PeriodCard | null;
  };
  full_day_timeline: PeriodCard[];
  assets: Asset[];
}

export interface ResourceLockView {
  resource_type: string;
  resource_id: string;
  holder_user_id: number;
  holder_name: string;
  holder_role: string;
  expires_at: string;
}
