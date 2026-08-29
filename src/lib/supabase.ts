import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Client anon SANS session : réservé aux données publiques (chapitres, providers).
// Ce client ne doit ni lire ni rafraîchir de token localStorage — un refresh
// concurrent avec un token périmé fait révoquer toute la session par Supabase
// (reuse detection). La session utilisateur vit côté application, dans les
// cookies via @supabase/ssr.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
})
