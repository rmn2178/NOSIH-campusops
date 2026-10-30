import type { SpaceKind } from '../api/client';

export interface SpaceOption {
  code: string;
  name: string;
  kind: SpaceKind;
  block?: 'A' | 'B' | 'C';
  floor?: number;
}

export const CLASSROOMS: SpaceOption[] = (['A', 'B', 'C'] as const).flatMap((block) => {
  const floors = block === 'A' ? 3 : block === 'B' ? 5 : 7;
  return Array.from({ length: floors }, (_, floorIndex) =>
    Array.from({ length: 6 }, (_, roomIndex) => ({
      code: `${block}${floorIndex + 1}-${String(roomIndex + 1).padStart(2, '0')}`,
      name: `${block} Block · Floor ${floorIndex + 1} · Room ${roomIndex + 1}`,
      kind: 'CLASSROOM' as const,
      block,
      floor: floorIndex + 1,
    })),
  ).flat();
});

const labGroups = [
  ['CHEM', 'Chemistry', 4],
  ['PHYS', 'Physics', 4],
  ['OOPS', 'OOPS', 4],
  ['DBMS', 'DBMS', 4],
  ['MECH', 'Mech', 2],
  ['ECE', 'ECE', 2],
] as const;

export const LABS: SpaceOption[] = labGroups.flatMap(([code, name, count]) =>
  Array.from({ length: count }, (_, index) => ({
    code: `LAB-${code}-${String(index + 1).padStart(2, '0')}`,
    name: `${name} Lab ${index + 1}`,
    kind: 'LAB' as const,
  })),
);

export const CANTEENS: SpaceOption[] = [
  'Cafe Tea & Things',
  'Bakery',
  'Breakfast Counter',
  'Lunch Hall',
  'Chai Kings',
].map((name, index) => ({ code: `CAN-${String(index + 1).padStart(2, '0')}`, name, kind: 'CANTEEN' }));

export const BILL_BOTS: SpaceOption[] = Array.from({ length: 8 }, (_, index) => ({
  code: `BOT-${String(index + 1).padStart(2, '0')}`,
  name: `Bill Bot ${index + 1}`,
  kind: 'BILL_BOT' as const,
}));

export const ALL_SPACES = [...CLASSROOMS, ...LABS, ...CANTEENS, ...BILL_BOTS];

export function normalizeSpaceCode(input: string): string {
  const value = input.trim().toUpperCase().replace(/\s+/g, '');
  const classroom = value.match(/^([ABC])(\d+)-(\d{1,2})$/);
  if (classroom) {
    const [, block, rawFloor, rawRoom] = classroom;
    const floor = Number(rawFloor) === 0 ? 1 : Number(rawFloor);
    return `${block}${floor}-${rawRoom.padStart(2, '0')}`;
  }
  return value;
}

export function findSpace(input: string): SpaceOption | undefined {
  const normalized = normalizeSpaceCode(input);
  return ALL_SPACES.find((space) => space.code === normalized);
}

export function spacesForKind(kind: SpaceKind): SpaceOption[] {
  if (kind === 'CLASSROOM') return CLASSROOMS;
  if (kind === 'LAB') return LABS;
  if (kind === 'CANTEEN') return CANTEENS;
  return BILL_BOTS;
}
