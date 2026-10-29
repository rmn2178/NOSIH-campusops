import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Building, Check, ChevronDown, FlaskConical, LoaderCircle, MapPin, Search, Store, Zap } from 'lucide-react';
import { api } from '../api/client';
import type { AssetTarget, SpaceDetails, SpaceKind } from '../api/client';
import { findSpace, normalizeSpaceCode, spacesForKind } from '../data/campus';
import type { SpaceOption } from '../data/campus';
import { cx } from '../lib/format';
import { StatusPill, toneForStatus } from './StatusPill';

interface CampusSpacePickerProps {
  value: string;
  onChange: (spaceCode: string) => void;
  selectedAssets: AssetTarget[];
  onAssetsChange: (assets: AssetTarget[]) => void;
  disabled?: boolean;
}

const spaceTabs: Array<{ kind: SpaceKind; label: string; icon: typeof Building }> = [
  { kind: 'CLASSROOM', label: 'Classrooms', icon: Building },
  { kind: 'LAB', label: 'Labs', icon: FlaskConical },
  { kind: 'CANTEEN', label: 'Canteens', icon: Store },
  { kind: 'BILL_BOT', label: 'Bill Bots', icon: Bot },
];

export function CampusSpacePicker({ value, onChange, selectedAssets, onAssetsChange, disabled = false }: CampusSpacePickerProps) {
  const [kind, setKind] = useState<SpaceKind>('CLASSROOM');
  const [block, setBlock] = useState<'A' | 'B' | 'C'>('C');
  const [floor, setFloor] = useState(4);
  const [room, setRoom] = useState('C4-03');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [details, setDetails] = useState<SpaceDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const options = useMemo(() => spacesForKind(kind), [kind]);
  const selected = useMemo(() => findSpace(value), [value]);
  const matches = useMemo(() => {
    const query = normalizeSpaceCode(search);
    if (!query) return [];
    return spacesForKind(kind).filter((space) =>
      space.code.includes(query) || space.name.toUpperCase().includes(query),
    ).slice(0, 7);
  }, [kind, search]);

  useEffect(() => {
    if (!value) {
      setDetails(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setDetails(null);
    api.getSpace(value, controller.signal)
      .then((space) => {
        if (!controller.signal.aborted) setDetails(space);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to load this space.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [value, reloadKey]);

  const chooseSpace = (space: SpaceOption) => {
    onChange(space.code);
    onAssetsChange([]);
    setSearch('');
    setSearchOpen(false);
    if (space.kind === 'CLASSROOM' && space.block && space.floor) {
      setBlock(space.block);
      setFloor(space.floor);
      setRoom(space.code);
    }
  };

  const changeKind = (nextKind: SpaceKind) => {
    setKind(nextKind);
    onAssetsChange([]);
    onChange(nextKind === 'CLASSROOM' ? room : '');
    setDetails(null);
    setSearch('');
  };

  const classroomOptions = spacesForKind('CLASSROOM').filter((space) => space.block === block && space.floor === floor);

  const toggleAsset = (asset: AssetTarget) => {
    const exists = selectedAssets.some((item) => item.asset_code === asset.asset_code);
    onAssetsChange(exists
      ? selectedAssets.filter((item) => item.asset_code !== asset.asset_code)
      : [...selectedAssets, { asset_code: asset.asset_code, asset_type: asset.asset_type, slot_index: asset.slot_index }]);
  };

  return (
    <div>
      <div className="no-scrollbar flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Campus space type">
        {spaceTabs.map(({ kind: tabKind, label, icon: Icon }) => (
          <button
            key={tabKind}
            type="button"
            role="tab"
            aria-selected={kind === tabKind}
            disabled={disabled}
            onClick={() => changeKind(tabKind)}
            className={cx('flex shrink-0 items-center gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-medium transition', kind === tabKind ? 'border-ink/30 bg-white text-ink shadow-sm' : 'border-stitch bg-silk/60 text-stone hover:bg-white')}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      <div className="relative mt-4">
        <label htmlFor="space-search" className="field-label">Find a {kind === 'BILL_BOT' ? 'bill bot' : kind.toLowerCase().replace('_', ' ')}</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-3.5 text-stone" size={17} />
          <input
            id="space-search"
            className="field pl-11"
            value={search}
            disabled={disabled}
            placeholder={kind === 'CLASSROOM' ? 'Try C4-03 or c0-01' : `Search ${options.length} locations`}
            onChange={(event) => {
              setSearch(event.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                const exact = findSpace(search);
                const match = exact && exact.kind === kind ? exact : matches[0];
                if (match) chooseSpace(match);
              }
              if (event.key === 'Escape') setSearchOpen(false);
            }}
          />
        </div>
        <AnimatePresence>
          {searchOpen && search && matches.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="absolute z-30 mt-2 w-full overflow-hidden rounded-xl border border-stitch bg-white p-1.5 shadow-lift"
            >
              {matches.map((space) => (
                <button
                  type="button"
                  key={space.code}
                  onClick={() => chooseSpace(space)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-silk"
                >
                  <MapPin size={15} className="text-stone" />
                  <span className="mono text-xs font-semibold">{space.code}</span>
                  <span className="truncate text-xs text-stone">{space.name}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {kind === 'CLASSROOM' ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="space-block" className="field-label">Block</label>
            <div className="relative">
              <select
                id="space-block"
                className="field appearance-none"
                disabled={disabled}
                value={block}
                onChange={(event) => {
                  const nextBlock = event.target.value as 'A' | 'B' | 'C';
                  const maxFloor = nextBlock === 'A' ? 3 : nextBlock === 'B' ? 5 : 7;
                  const nextFloor = Math.min(floor, maxFloor);
                  setBlock(nextBlock);
                  setFloor(nextFloor);
                  setRoom(`${nextBlock}${nextFloor}-01`);
                  onChange(`${nextBlock}${nextFloor}-01`);
                  onAssetsChange([]);
                }}
              >
                <option value="A">A · 3 floors</option>
                <option value="B">B · 5 floors</option>
                <option value="C">C · 7 floors</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3.5 text-stone" size={16} />
            </div>
          </div>
          <div>
            <label htmlFor="space-floor" className="field-label">Floor</label>
            <div className="relative">
              <select
                id="space-floor"
                className="field appearance-none"
                disabled={disabled}
                value={floor}
                onChange={(event) => {
                  const nextFloor = Number(event.target.value);
                  setFloor(nextFloor);
                  setRoom(`${block}${nextFloor}-01`);
                  onChange(`${block}${nextFloor}-01`);
                  onAssetsChange([]);
                }}
              >
                {Array.from({ length: block === 'A' ? 3 : block === 'B' ? 5 : 7 }, (_, index) => (
                  <option key={index + 1} value={index + 1}>Floor {index + 1}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3.5 text-stone" size={16} />
            </div>
          </div>
          <div>
            <label htmlFor="space-room" className="field-label">Room</label>
            <div className="relative">
              <select
                id="space-room"
                className="field mono appearance-none"
                disabled={disabled}
                value={value && selected?.kind === 'CLASSROOM' ? value : room}
                onChange={(event) => {
                  setRoom(event.target.value);
                  onChange(event.target.value);
                  onAssetsChange([]);
                }}
              >
                {classroomOptions.map((space) => <option key={space.code} value={space.code}>{space.code}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3.5 text-stone" size={16} />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-5 grid max-h-64 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {options.map((space) => (
            <button
              type="button"
              key={space.code}
              disabled={disabled}
              onClick={() => chooseSpace(space)}
              className={cx('flex items-center gap-3 rounded-xl border p-3 text-left transition', value === space.code ? 'border-ink/35 bg-white shadow-sm' : 'border-stitch bg-silk/50 hover:bg-white')}
            >
              <span className="mono text-xs font-semibold">{space.code}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-stone">{space.name}</span>
              {value === space.code && <Check size={15} />}
            </button>
          ))}
        </div>
      )}

      {!value && <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Choose a campus location to continue.</p>}

      {value && (
        <div className="mt-5 overflow-hidden rounded-2xl border border-stitch bg-white">
          <div className="flex flex-wrap items-center gap-3 border-b border-stitch bg-silk/50 px-4 py-3">
            <span className="mono text-sm font-semibold">{value}</span>
            <span className="text-xs text-stone">{selected?.name}</span>
            {details && <StatusPill label={details.visual_state.replaceAll('_', ' ')} tone={toneForStatus(details.visual_state)} dot className="ml-auto" />}
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-stone" role="status">
              <LoaderCircle size={17} className="animate-spin" /> Loading live space details…
            </div>
          )}
          {error && (
            <div className="flex flex-wrap items-center gap-3 px-4 py-4 text-sm text-red-800">
              <span className="flex-1">{error}</span>
              <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setReloadKey((key) => key + 1)}>Retry</button>
            </div>
          )}
          {details && !loading && (
            <div>
              {details.current_period && (
                <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-stitch px-4 py-3 text-xs text-stone">
                  <span className="font-semibold text-ink">Current period {details.current_period.period_number ? `P${details.current_period.period_number}` : ''}</span>
                  <span>{details.current_period.class_code || 'No active class'}</span>
                  {details.current_period.subject_title && <span>{details.current_period.subject_title}</span>}
                  {details.current_period.away_in_lab_code && <span className="mono">Away: {details.current_period.away_in_lab_code}</span>}
                </div>
              )}
              <div className="p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold">Select affected assets <span className="font-normal text-stone">(optional)</span></p>
                    <p className="mt-1 text-[11px] text-stone">Tap exact units to help the response team.</p>
                  </div>
                  {selectedAssets.length > 0 && <span className="mono text-[11px] text-stone">{selectedAssets.length} selected</span>}
                </div>
                {details.assets.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                    {details.assets.map((asset) => {
                      const active = selectedAssets.some((item) => item.asset_code === asset.asset_code);
                      return (
                        <button
                          type="button"
                          key={asset.asset_code}
                          disabled={disabled}
                          onClick={() => toggleAsset(asset)}
                          aria-pressed={active}
                          title={`${asset.asset_code} · ${asset.status}`}
                          className={cx('relative rounded-xl border px-2 py-3 text-center transition', active ? 'border-ink/40 bg-silk ring-1 ring-ink/10' : 'border-stitch bg-white hover:bg-silk/60', asset.status === 'FAULTY' && !active && 'border-red-200 bg-red-50')}
                        >
                          {active && <Check className="absolute right-1.5 top-1.5" size={11} />}
                          <Zap size={13} className="mx-auto mb-1.5 text-stone" />
                          <span className="mono block truncate text-[9px] font-medium">{asset.asset_code.split('-').slice(-2).join('-')}</span>
                          <span className={cx('mt-1 block text-[8px] uppercase', asset.status === 'FAULTY' ? 'text-red-700' : 'text-stone')}>{asset.status}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-stone">No selectable assets were returned for this space. You can still describe the issue below.</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
