import type { TwinSpace } from "./campus";
import type { Complaint } from "./operations";

export interface TwinStateMutatedEvent {
  type: "TWIN_STATE_MUTATED";
  payload: {
    space_code: string;
    visual_state: string;
    complaint_id?: number;
    ticket_number?: string;
    work_order_id?: number;
  };
}

export interface ComplaintCreatedEvent {
  type: "COMPLAINT_CREATED";
  payload: Complaint;
}

export interface TwinSnapshotEvent {
  type: "TWIN_SNAPSHOT";
  payload: TwinSpace[];
}

export type NosihSocketEvent = TwinStateMutatedEvent | ComplaintCreatedEvent | TwinSnapshotEvent;
