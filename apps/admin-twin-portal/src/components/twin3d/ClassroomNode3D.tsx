import { useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { AlertTriangle, LockKeyhole } from 'lucide-react';
import type { TwinSpace } from '../../types';
import type { CampusNodeLayout } from './campusLayout';

const stateColors = {
  HEALTHY: { body: '#ECFDF5', emissive: '#4ADE80', edge: '#86EFAC' },
  FAULTY: { body: '#FEE2E2', emissive: '#F87171', edge: '#EF4444' },
  DEGRADED: { body: '#FDE68A', emissive: '#F59E0B', edge: '#FBBF24' },
  BLOCKED_PARTS: { body: '#FEE2E2', emissive: '#F87171', edge: '#A855F7' },
};

export function ClassroomNode3D({ layout, space, selected, onSelect }: {
  layout: CampusNodeLayout;
  space?: TwinSpace;
  selected: boolean;
  onSelect: (code: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const group = useRef<THREE.Group>(null);
  const material = useRef<THREE.MeshStandardMaterial>(null);
  const status = space?.visual_state;
  const colors = status ? stateColors[status] : { body: '#F3F1EC', emissive: '#D6D3D1', edge: '#D6D3D1' };
  const isBot = layout.kind === 'BILL_BOT';
  const isCanteen = layout.kind === 'CANTEEN';
  const showLabel = hovered || selected || status === 'FAULTY' || status === 'BLOCKED_PARTS';
  const dimensions = useMemo<[number, number, number]>(() => isBot ? [0.72, 1.3, 0.72] : isCanteen ? [3.4, 1.3, 3] : layout.kind === 'LAB' ? [2.75, 1.55, 2.55] : [2.55, 1.7, 2.42], [isBot, isCanteen, layout.kind]);
  const targetColor = useMemo(() => new THREE.Color(colors.body), [colors.body]);
  const targetEmissive = useMemo(() => new THREE.Color(colors.emissive), [colors.emissive]);

  useFrame(({ clock }) => {
    if (material.current) {
      const pulse = status === 'FAULTY' || status === 'BLOCKED_PARTS' ? 0.55 + Math.sin(clock.elapsedTime * 3.5) * 0.28 : 0.16;
      material.current.color.lerp(targetColor, 0.08);
      material.current.emissive.lerp(targetEmissive, 0.08);
      material.current.emissiveIntensity = selected ? 0.65 : pulse;
    }
    if (group.current) group.current.position.y = layout.position[1] + (hovered ? 0.12 : 0);
  });

  const select = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect(layout.code); };
  const label = space?.active_ticket_id ?? (space?.active_fault_count ? `${space.active_fault_count} active fault${space.active_fault_count > 1 ? 's' : ''}` : layout.code);
  const isFaulted = status === 'FAULTY' || status === 'BLOCKED_PARTS';
  const showDetail = hovered || selected;

  return <group ref={group} position={layout.position}>
    {(isFaulted || status === 'DEGRADED') && <mesh position={[0, -layout.position[1] + 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[isBot ? 0.85 : 1.75, isBot ? 1.05 : 2.0, 48]} />
      <meshBasicMaterial color={colors.edge} transparent opacity={isFaulted ? 0.5 : 0.28} side={THREE.DoubleSide} />
    </mesh>}
    <mesh
      castShadow receiveShadow onClick={select}
      onPointerOver={(event) => { event.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      scale={selected ? 1.04 : 1}
    >
      {isBot ? <cylinderGeometry args={[0.42, 0.52, 1.3, 16]} /> : <boxGeometry args={dimensions} />}
      <meshStandardMaterial ref={material} color={colors.body} emissive={colors.emissive} emissiveIntensity={0.16} transparent opacity={status ? 0.88 : 0.62} roughness={0.22} metalness={0.06} />
    </mesh>
    {!isBot && <mesh position={[0, dimensions[1] / 2 + 0.02, 0]} castShadow>
      <boxGeometry args={[dimensions[0] * 0.94, 0.05, dimensions[2] * 0.94]} />
      <meshStandardMaterial color="#FFFFFF" roughness={0.5} transparent opacity={0.9} />
    </mesh>}
    {!isBot && <lineSegments>
      {isCanteen ? <cylinderGeometry args={[2.1, 2.1, 1.35, 4]} /> : <boxGeometry args={dimensions} />}
      <lineBasicMaterial color={selected ? '#141413' : colors.edge} transparent opacity={selected ? 0.85 : 0.34} />
    </lineSegments>}
    {isCanteen && <mesh position={[0, 1.05, 0]} rotation={[0, Math.PI / 4, 0]} castShadow><coneGeometry args={[2.35, 0.75, 4]} /><meshStandardMaterial color="#FEFEFE" roughness={0.7} /></mesh>}
    {isBot && <mesh position={[0, 0.2, 0.43]}><boxGeometry args={[0.38, 0.34, 0.04]} /><meshStandardMaterial color={status === 'FAULTY' ? '#EF4444' : '#334155'} emissive={colors.emissive} emissiveIntensity={0.3} /></mesh>}
    {status === 'BLOCKED_PARTS' && <mesh position={[0, -dimensions[1] / 2 - 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[isBot ? 0.68 : 1.5, isBot ? 0.78 : 1.62, 40]} /><meshBasicMaterial color="#A855F7" side={THREE.DoubleSide} transparent opacity={0.9} /></mesh>}
    {showDetail && space?.is_occupied_now && layout.kind === 'CLASSROOM' && <Html position={[0, 1.35, 0]} center distanceFactor={24} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}><div className="mono whitespace-nowrap rounded-full border border-cyan-200 bg-cyan-50/95 px-2 py-1 text-[8px] font-semibold text-cyan-800 shadow-sm">{space.current_student_count ?? 0} / {space.room_capacity ?? 60}</div></Html>}
    {showDetail && space?.is_home_class_in_lab && layout.kind === 'CLASSROOM' && !space.is_occupied_now && <Html position={[0, 1.25, 0]} center distanceFactor={25} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}><div className="whitespace-nowrap rounded-sm border border-emerald-200 bg-white/95 px-1.5 py-1 text-[7px] font-semibold tracking-wide text-emerald-800">VACANT · CLASS IN LAB</div></Html>}
    {showDetail && (space?.queue_count !== undefined && isCanteen) && <Html position={[0, 1.8, 0]} center distanceFactor={22} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}><div className="mono whitespace-nowrap rounded-full bg-white px-2 py-1 text-[8px] shadow">Queue {space.queue_count}</div></Html>}
    {showLabel && <Html position={[0, isCanteen ? 2.4 : 1.6, 0]} center distanceFactor={22} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg border bg-white/95 px-2.5 py-1.5 text-[9px] shadow-lg backdrop-blur ${isFaulted ? 'border-red-200 text-red-900' : 'border-stitch text-obsidian'}`}>
        {isFaulted && <AlertTriangle className="h-3 w-3" />}{space?.has_active_lock && <LockKeyhole className="h-3 w-3" />}<span className="mono font-medium">{layout.code}</span>{label !== layout.code && <span>· {label}</span>}
      </div>
    </Html>}
  </group>;
}
