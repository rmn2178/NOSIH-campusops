import { create } from 'zustand';
import type { CampusClock, TwinSpace, WorkspaceId } from '../types';

interface PortalState {
  workspace: WorkspaceId;
  selectedSpaceCode: string | null;
  floorExplode: number;
  overview: Record<string, TwinSpace>;
  overviewLoadedAt: string | null;
  clock: CampusClock | null;
  socketStatus: 'connecting' | 'live' | 'offline';
  twinRevision: number;
  notice: string | null;
  setWorkspace: (workspace: WorkspaceId) => void;
  selectSpace: (code: string | null) => void;
  setFloorExplode: (value: number) => void;
  setOverview: (spaces: TwinSpace[]) => void;
  setClock: (clock: CampusClock) => void;
  setSocketStatus: (status: PortalState['socketStatus']) => void;
  invalidateTwin: (message?: string) => void;
  clearNotice: () => void;
}

export const usePortalStore = create<PortalState>((set) => ({
  workspace: 'twin',
  selectedSpaceCode: null,
  floorExplode: 0.35,
  overview: {},
  overviewLoadedAt: null,
  clock: null,
  socketStatus: 'connecting',
  twinRevision: 0,
  notice: null,
  setWorkspace: (workspace) => set({ workspace }),
  selectSpace: (selectedSpaceCode) => set({ selectedSpaceCode }),
  setFloorExplode: (floorExplode) => set({ floorExplode }),
  setOverview: (spaces) => set({
    overview: Object.fromEntries(spaces.map((space) => [space.code, space])),
    overviewLoadedAt: new Date().toISOString(),
  }),
  setClock: (clock) => set({ clock }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  invalidateTwin: (message) => set((state) => ({ twinRevision: state.twinRevision + 1, notice: message ?? state.notice })),
  clearNotice: () => set({ notice: null }),
}));
