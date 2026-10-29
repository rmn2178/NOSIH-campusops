import { Suspense, useEffect, useMemo, useRef } from 'react';
import { ContactShadows, Html, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { TwinSpace } from '../../types';
import { ClassroomNode3D } from './ClassroomNode3D';
import { TopologyArcs3D } from './TopologyArcs3D';
import { getCampusLayout, getTowerStructures, type CampusNodeLayout } from './campusLayout';

function CameraRig({ selectedCode, layout }: { selectedCode: string | null; layout: CampusNodeLayout[] }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as { target: THREE.Vector3; update: () => void } | null;
  const destination = useRef<THREE.Vector3 | null>(null);
  const target = useRef<THREE.Vector3 | null>(null);
  useEffect(() => {
    if (!selectedCode) { destination.current = null; target.current = null; return; }
    const node = layout.find((item) => item.code === selectedCode);
    if (!node) return;
    target.current = new THREE.Vector3(...node.position);
    destination.current = new THREE.Vector3(...node.position).add(new THREE.Vector3(7, 5.5, 9));
  }, [selectedCode, layout]);
  useFrame(() => {
    if (!destination.current || !target.current || !controls) return;
    camera.position.lerp(destination.current, 0.065);
    controls.target.lerp(target.current, 0.08);
    controls.update();
    if (camera.position.distanceTo(destination.current) < 0.04) destination.current = null;
  });
  return null;
}

function TowerStructures({ explode }: { explode: number }) {
  const structures = getTowerStructures(explode);
  return <>{structures.map((structure) => <group key={`${structure.block}-${structure.floor}`} position={structure.position}>
    <mesh receiveShadow castShadow><boxGeometry args={[8.75, 0.13, 5.8]} /><meshStandardMaterial color="#F8F7F3" roughness={0.88} /></mesh>
    <mesh position={[0, -0.09, 0]}><boxGeometry args={[8.95, 0.05, 6.0]} /><meshStandardMaterial color="#E3E0D8" roughness={0.95} /></mesh>
    {structure.floor === 1 && <>
      <mesh position={[0, -0.6, 0]} receiveShadow><boxGeometry args={[9.6, 1.1, 6.7]} /><meshStandardMaterial color="#EFEDE6" roughness={0.92} /></mesh>
      <mesh position={[3.6, 0.9, 0]} castShadow><boxGeometry args={[0.55, 2.1, 0.55]} /><meshStandardMaterial color="#E7E4DC" roughness={0.9} /></mesh>
      <Html position={[-4.8, 0.4, 0]} center distanceFactor={28} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}><div className="rounded-full border border-white/80 bg-white/75 px-3 py-1 text-[9px] font-semibold uppercase tracking-[.18em] text-stone shadow-sm backdrop-blur">Block {structure.block}</div></Html>
    </>}
  </group>)}</>;
}

function CampusScene({ overview, selectedCode, explode, onSelect }: {
  overview: Record<string, TwinSpace>;
  selectedCode: string | null;
  explode: number;
  onSelect: (code: string) => void;
}) {
  const layout = useMemo(() => getCampusLayout(explode), [explode]);
  return <>
    <color attach="background" args={['#F2F1EC']} />
    <fog attach="fog" args={['#F2F1EC', 62, 125]} />
    <ambientLight intensity={0.95} />
    <hemisphereLight args={['#FFFFFF', '#CFC9BC', 0.75]} />
    <directionalLight position={[-18, 32, 18]} intensity={1.75} color="#FFFDF7" castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-35} shadow-camera-right={35} shadow-camera-top={35} shadow-camera-bottom={-35} shadow-bias={-0.0004} />
    <directionalLight position={[25, 12, -20]} intensity={0.45} color="#DCE9FF" />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, 0]} receiveShadow><planeGeometry args={[160, 160]} /><meshStandardMaterial color="#E6E4DC" roughness={0.98} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow><circleGeometry args={[46, 64]} /><meshStandardMaterial color="#EDEBE4" roughness={0.96} /></mesh>
    <gridHelper args={[90, 45, '#D6D3CA', '#E1DED6']} position={[0, -0.08, 0]} />
    <TowerStructures explode={explode} />
    <group position={[-9.5, 0, 11.6]}>
      <mesh receiveShadow><boxGeometry args={[17.2, 0.16, 13.1]} /><meshStandardMaterial color="#F5F3ED" roughness={0.9} /></mesh>
      <mesh position={[0, -0.55, 0]} receiveShadow><boxGeometry args={[17.9, 1.0, 13.8]} /><meshStandardMaterial color="#EFEDE6" roughness={0.92} /></mesh>
    </group>
    <Html position={[-18.4, 0.35, 5.8]} center distanceFactor={30} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}><div className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-[.18em] text-stone">Specialized lab wing · 20</div></Html>
    {layout.map((node) => <ClassroomNode3D key={node.code} layout={node} space={overview[node.code]} selected={selectedCode === node.code} onSelect={onSelect} />)}
    <TopologyArcs3D spaces={overview} layout={layout} />
    <ContactShadows position={[0, -0.06, 0]} opacity={0.42} scale={75} blur={2.6} far={35} resolution={512} color="#5F5B52" frames={1} />
    <OrbitControls makeDefault enableDamping dampingFactor={0.065} minDistance={7} maxDistance={85} maxPolarAngle={Math.PI / 2.08} target={[0, 3, 0]} />
    <CameraRig selectedCode={selectedCode} layout={layout} />
    <EffectComposer multisampling={0}><Bloom intensity={0.3} luminanceThreshold={0.78} luminanceSmoothing={0.4} mipmapBlur /><Vignette eskil={false} offset={0.16} darkness={0.3} /></EffectComposer>
  </>;
}

export function CampusCanvas3D({ overview, selectedCode, explode, onSelect }: {
  overview: Record<string, TwinSpace>;
  selectedCode: string | null;
  explode: number;
  onSelect: (code: string) => void;
}) {
  return <Canvas shadows dpr={[1, 1.65]} camera={{ position: [34, 29, 43], fov: 38, near: 0.1, far: 180 }} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.05; }}>
    <Suspense fallback={null}><CampusScene overview={overview} selectedCode={selectedCode} explode={explode} onSelect={onSelect} /></Suspense>
  </Canvas>;
}
