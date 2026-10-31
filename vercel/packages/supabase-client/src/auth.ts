import { supabase, unwrap } from './client';

export interface AppProfile {
  id: number;
  email: string;
  full_name: string;
  role: 'STUDENT' | 'FACULTY' | 'LAB_STAFF' | 'MAINTENANCE' | 'INCIDENT_MANAGER' | 'FACILITIES_ADMIN' | 'PROCUREMENT_APPROVER' | 'SYSTEM_ADMIN';
  department_code: string | null;
  year_number: number | null;
  class_code: string | null;
  staff_code: string | null;
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function currentProfile(): Promise<AppProfile | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data, error } = await supabase
    .from('users')
    .select('id,email,full_name,role,department_code,year_number,class_code,staff_profiles(staff_code)')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (error || !data) return null;
  const staff = Array.isArray(data.staff_profiles) ? data.staff_profiles[0] : data.staff_profiles;
  return {
    id: data.id,
    email: data.email,
    full_name: data.full_name,
    role: data.role,
    department_code: data.department_code,
    year_number: data.year_number,
    class_code: data.class_code,
    staff_code: staff?.staff_code ?? null,
  };
}

export async function accessToken(): Promise<string> {
  const session = await currentSession();
  return session?.access_token ?? '';
}

export function authUserId(): string | null {
  // Synchronous best-effort read used for storage paths.
  const key = Object.keys(localStorage).find((item) => item.endsWith('-auth-token'));
  if (!key) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
    return parsed?.user?.id ?? null;
  } catch {
    return null;
  }
}

export { unwrap };
