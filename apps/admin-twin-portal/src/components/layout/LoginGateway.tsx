import { useState, type FormEvent } from 'react';
import { ArrowRight, Box, CheckCircle2, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { Button, ErrorBanner } from '../ui';

const roleNames = ['Maintenance Technician', 'Incident Manager', 'Facilities Administrator', 'Procurement Approver', 'Department Manager', 'System Administrator'];

export function LoginGateway() {
  const { login, authenticating, error } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await login(email, password).catch(() => undefined);
  };

  return <main className="cloth-canvas flex min-h-screen items-center justify-center p-4 sm:p-8">
    <div className="grid w-full max-w-6xl overflow-hidden rounded-[28px] border border-white bg-white shadow-float lg:grid-cols-[1.08fr_.92fr]">
      <section className="relative hidden min-h-[680px] overflow-hidden bg-[#efeee9] p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="hairline-grid absolute inset-0 opacity-40" />
        <div className="absolute -right-20 top-28 h-[420px] w-[420px] rounded-full border border-white/80" />
        <div className="absolute -right-2 top-44 h-[280px] w-[280px] rounded-full border border-white/80" />
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-obsidian text-white"><Box className="h-5 w-5" /></div>
          <div><p className="text-sm font-semibold tracking-[.14em]">NOSIH</p><p className="text-[10px] uppercase tracking-[.18em] text-stone">Campus operating system</p></div>
        </div>
        <div className="relative z-10 max-w-lg">
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-[.24em] text-stone">Spatial intelligence · Operational clarity</p>
          <h1 className="text-balance text-[52px] font-medium leading-[1.04] tracking-[-.055em]">The campus,<br />made legible.</h1>
          <p className="mt-6 max-w-md text-sm leading-7 text-stone">A living architectural twin for facilities, incidents, resources and academic time—held to deterministic operational constraints.</p>
          <div className="mt-10 grid grid-cols-3 gap-3">
            {[['123', 'Live spaces'], ['06', 'Period context'], ['01', 'Verified ledger']].map(([value, label]) => <div key={label} className="border-t border-[#cfcdc5] pt-3"><p className="mono text-xl">{value}</p><p className="mt-1 text-[10px] uppercase tracking-wider text-stone">{label}</p></div>)}
          </div>
        </div>
        <p className="relative z-10 text-[10px] uppercase tracking-[.18em] text-stone">National Institute of Science & Integrated Health</p>
      </section>

      <section className="flex flex-col justify-center px-6 py-10 sm:px-12 sm:py-14">
        <div className="mb-10 flex items-center gap-3 lg:hidden"><div className="rounded-lg bg-obsidian p-2 text-white"><Box className="h-5 w-5" /></div><span className="font-semibold tracking-widest">NOSIH</span></div>
        <div className="mb-8"><div className="mb-5 inline-flex items-center gap-2 rounded-full border border-stitch bg-linen px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-stone"><ShieldCheck className="h-3.5 w-3.5" /> Authorized operations only</div>
          <h2 className="text-3xl font-semibold tracking-[-.04em]">Command portal</h2><p className="mt-2 text-sm leading-6 text-stone">Sign in with your institutional administrator credentials. Your assigned role determines the available workspaces.</p></div>
        <form onSubmit={submit} className="space-y-5">
          {error && <ErrorBanner message={error} />}
          <label className="block"><span className="mb-2 block text-xs font-medium">College email</span>
            <input required type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@nosih.edu.in" className="h-12 w-full rounded-xl border border-stitch bg-silk px-4 text-sm outline-none transition focus:border-stone-400 focus:bg-white focus:ring-4 focus:ring-black/[.03]" />
          </label>
          <label className="block"><span className="mb-2 block text-xs font-medium">Password</span>
            <div className="relative"><LockKeyhole className="absolute left-4 top-4 h-4 w-4 text-stone" /><input required type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="h-12 w-full rounded-xl border border-stitch bg-silk pl-11 pr-12 text-sm outline-none transition focus:border-stone-400 focus:bg-white focus:ring-4 focus:ring-black/[.03]" />
              <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute right-4 top-4 text-stone hover:text-obsidian">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
          </label>
          <Button type="submit" disabled={authenticating} className="h-12 w-full rounded-xl">{authenticating ? 'Verifying credentials…' : 'Enter command portal'}<ArrowRight className="h-4 w-4" /></Button>
        </form>
        <div className="mt-8 border-t border-stitch pt-6"><p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-stone"><CheckCircle2 className="h-3.5 w-3.5" /> Server-enforced role access</p>
          <div className="flex flex-wrap gap-1.5">{roleNames.map((role) => <span key={role} className="rounded-md bg-silk px-2 py-1 text-[10px] text-stone">{role}</span>)}</div></div>
      </section>
    </div>
  </main>;
}
