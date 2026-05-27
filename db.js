'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('❌  SUPABASE_URL və SUPABASE_SERVICE_KEY .env faylında olmalıdır!');
  process.exit(1);
}

// Service Role Key → RLS-i keçir, tam giriş
const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

module.exports = supabase;
