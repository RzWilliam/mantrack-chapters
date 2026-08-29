import { createClient } from '@supabase/supabase-js'

// Client admin pour bypasser les RLS (côté serveur uniquement)
// NE JAMAIS IMPORTER CE FICHIER DANS DES COMPOSANTS CLIENT !
// Utilise la clé service_role qui a tous les droits

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseServiceKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not defined in environment variables')
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})
