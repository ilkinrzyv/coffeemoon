'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('❌  SUPABASE_URL və SUPABASE_SERVICE_KEY .env faylında olmalıdır!');
  process.exit(1);
}

// DİQQƏT: Node 22-dən əvvəlki versiyalarda qlobal `WebSocket` YOXDUR.
// @supabase/supabase-js klient qurularkən RealtimeClient yaradır və WebSocket axtarır;
// tapmasa server BAŞLAYAN ANDA çökür ("Node.js 18 detected without native WebSocket support").
// Railway hazırda Node 18 işlədir → `ws` paketini transport kimi özümüz veririk.
// Belədə Node versiyasından asılılıq tamamilə aradan qalxır.
// (Realtime funksiyasını istifadə etmirik, amma klient onsuz qurulmur.)
const ws = require('ws');

// Service Role Key → RLS-i keçir, tam giriş
const supabase = createClient(url, key, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

module.exports = supabase;
