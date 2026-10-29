import type { SpaceKind } from '../../types';

export type Point3 = [number, number, number];
export interface CampusNodeLayout {
  code: string;
  kind: SpaceKind;
  name: string;
  position: Point3;
  block?: string;
  floor?: number;
}

const blockOrigins: Record<string, { floors: number; origin: Point3 }> = {
  A: { floors: 3, origin: [-14, 0, -9] },
  B: { floors: 5, origin: [-3, 0, -9] },
  C: { floors: 7, origin: [9, 0, -9] },
};

const labGroups = [
  ['CHEM', 4, 'Chemistry'], ['PHYS', 4, 'Physics'], ['OOPS', 4, 'OOPS'],
  ['DBMS', 4, 'DBMS'], ['MECH', 2, 'Mechanical'], ['ECE', 2, 'ECE'],
] as const;

export const canteenNames = ['Cafe Tea & Things', 'Bakery', 'Breakfast Counter', 'Lunch Hall', 'Chai Kings'];

export function getCampusLayout(explode: number): CampusNodeLayout[] {
  const classrooms = Object.entries(blockOrigins).flatMap(([block, config]) =>
    Array.from({ length: config.floors }, (_, floorIndex) =>
      Array.from({ length: 6 }, (_, roomIndex): CampusNodeLayout => ({
        code: `${block}${floorIndex + 1}-${String(roomIndex + 1).padStart(2, '0')}`,
        kind: 'CLASSROOM',
        name: `Block ${block} · Level ${floorIndex + 1}`,
        block,
        floor: floorIndex + 1,
        position: [
          config.origin[0] + (roomIndex % 3 - 1) * 2.85,
          1.15 + floorIndex * (2.45 + explode),
          config.origin[2] + (Math.floor(roomIndex / 3) - 0.5) * 2.75,
        ],
      })),
    ).flat(),
  );
  let labIndex = 0;
  const labs = labGroups.flatMap(([group, count, name]) => Array.from({ length: count }, (_, index): CampusNodeLayout => {
    const current = labIndex++;
    return {
      code: `LAB-${group}-${String(index + 1).padStart(2, '0')}`,
      kind: 'LAB',
      name: `${name} Lab ${index + 1}`,
      position: [-16 + (current % 5) * 3.25, 0.9, 7 + Math.floor(current / 5) * 3.1],
    };
  }));
  const canteens = canteenNames.map((name, index): CampusNodeLayout => ({
    code: `CAN-${String(index + 1).padStart(2, '0')}`,
    kind: 'CANTEEN',
    name,
    position: [5 + (index % 3) * 4.5, 0.75, 8 + Math.floor(index / 3) * 5],
  }));
  const botPositions: Point3[] = [
    [-17, 0.65, -1], [-9, 0.65, -1], [-5, 0.65, 1], [2, 0.65, 0],
    [6, 0.65, 2], [13, 0.65, 2], [17, 0.65, 7], [3, 0.65, 12],
  ];
  const bots = botPositions.map((position, index): CampusNodeLayout => ({
    code: `BOT-${String(index + 1).padStart(2, '0')}`,
    kind: 'BILL_BOT',
    name: `Bill Bot ${index + 1}`,
    position,
  }));
  return [...classrooms, ...labs, ...canteens, ...bots];
}

export const campusNodeCount = getCampusLayout(0).length;

export function getTowerStructures(explode: number) {
  return Object.entries(blockOrigins).flatMap(([block, config]) => Array.from({ length: config.floors }, (_, index) => ({
    block,
    floor: index + 1,
    position: [config.origin[0], index * (2.45 + explode), config.origin[2]] as Point3,
  })));
}
