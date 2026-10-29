import { ShieldCheck, UserRound } from 'lucide-react';
import { cx, roleLabel } from '../lib/format';
import { useAuthStore } from '../store/useAuthStore';

interface AnonymousSwitchProps {
  value: boolean;
  onChange: (anonymous: boolean) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function AnonymousSwitch({ value, onChange, compact = false, disabled = false }: AnonymousSwitchProps) {
  const user = useAuthStore((state) => state.user);

  if (compact) {
    return (
      <div className="grid grid-cols-2 rounded-xl border border-stitch bg-silk p-1" role="group" aria-label="Comment identity">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(false)}
          className={cx('flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition', !value ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink')}
          aria-pressed={!value}
        >
          <UserRound size={14} /> With my name
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(true)}
          className={cx('flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition', value ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink')}
          aria-pressed={value}
        >
          <ShieldCheck size={14} /> Anonymously
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Complaint identity privacy">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(false)}
        aria-pressed={!value}
        className={cx('rounded-2xl border p-4 text-left transition', !value ? 'border-ink/35 bg-white shadow-cloth ring-1 ring-ink/10' : 'border-stitch bg-silk/60 hover:bg-white')}
      >
        <span className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-stitch bg-white"><UserRound size={19} /></span>
          <span>
            <span className="block text-sm font-semibold">Show my name</span>
            <span className="mt-1 block text-xs leading-5 text-stone">{user?.full_name} · {user?.department} {user ? roleLabel(user.academic_role) : ''}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(true)}
        aria-pressed={value}
        className={cx('rounded-2xl border p-4 text-left transition', value ? 'border-ink/35 bg-white shadow-cloth ring-1 ring-ink/10' : 'border-stitch bg-silk/60 hover:bg-white')}
      >
        <span className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-stitch bg-white"><ShieldCheck size={19} /></span>
          <span>
            <span className="block text-sm font-semibold">Register anonymously</span>
            <span className="mt-1 block text-xs leading-5 text-stone">Your identity is sealed in the cryptographic vault.</span>
          </span>
        </span>
      </button>
    </div>
  );
}
