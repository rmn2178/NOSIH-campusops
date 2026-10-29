import { useMemo, useRef } from 'react';
import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TwinSpace } from '../../types';
import type { CampusNodeLayout } from './campusLayout';

function RerouteArc({ from, to }: { from: CampusNodeLayout; to: CampusNodeLayout }) {
  const marker = useRef<THREE.Mesh>(null);
  const curve = useMemo(() => {
    const start = new THREE.Vector3(...from.position).add(new THREE.Vector3(0, 1.4, 0));
    const end = new THREE.Vector3(...to.position).add(new THREE.Vector3(0, 1.4, 0));
    const middle = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, Math.max(3, start.distanceTo(end) * 0.3), 0));
    return new THREE.QuadraticBezierCurve3(start, middle, end);
  }, [from, to]);
  const points = useMemo(() => curve.getPoints(40), [curve]);
  const arrowDirection = useMemo(() => curve.getTangent(1).normalize(), [curve]);
  const arrowOrigin = useMemo(() => curve.getPoint(1).addScaledVector(arrowDirection, -0.8), [curve, arrowDirection]);
  useFrame(({ clock }) => {
    if (marker.current) marker.current.position.copy(curve.getPoint((clock.elapsedTime * 0.22) % 1));
  });
  return <group>
    <Line points={points} color="#EF4444" lineWidth={1.5} dashed dashSize={0.35} gapSize={0.2} transparent opacity={0.8} />
    <mesh ref={marker}><sphereGeometry args={[0.17, 12, 12]} /><meshBasicMaterial color="#EF4444" /></mesh>
    <mesh position={curve.getPoint(1)}><sphereGeometry args={[0.25, 12, 12]} /><meshBasicMaterial color="#4ADE80" /></mesh>
    <arrowHelper args={[arrowDirection, arrowOrigin, 0.8, '#EF4444', 0.35, 0.2]} />
  </group>;
}

export function TopologyArcs3D({ spaces, layout }: { spaces: Record<string, TwinSpace>; layout: CampusNodeLayout[] }) {
  const arcs = Object.values(spaces).filter((space) => space.kind === 'BILL_BOT' && space.visual_state === 'FAULTY' && space.rerouted_to_bot_code);
  return <>{arcs.map((space) => {
    const from = layout.find((node) => node.code === space.code);
    const to = layout.find((node) => node.code === space.rerouted_to_bot_code);
    return from && to ? <RerouteArc key={space.code} from={from} to={to} /> : null;
  })}</>;
}
