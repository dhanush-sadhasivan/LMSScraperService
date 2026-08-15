const { createClient } = require('@supabase/supabase-js');

let _client = null;

/**
 * Returns a singleton Supabase admin client using the service role key.
 * This bypasses Row Level Security (RLS) for all operations.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getSupabaseClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
    );
  }

  _client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}

module.exports = { getSupabaseClient };
