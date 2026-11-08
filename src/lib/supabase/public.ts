import 'server-only';
import { createClient } from '@supabase/supabase-js';

// This client deliberately has *no* end-user session. Public pages rely
// on anon RLS to determine what may be seen by everybody, including bots.
export function publicSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
