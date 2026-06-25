// ============================================================
// SUPABASE CLIENT - BACKEND
// ============================================================

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// ✅ Lecture depuis les variables d'environnement UNIQUEMENT
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

// ✅ Vérification stricte
if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERREUR CRITIQUE: Variables Supabase manquantes dans .env");
    console.error("   SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false
    }
});

console.log(`✅ Supabase connecté: ${supabaseUrl.replace(/https:\/\//, '')}`);

module.exports = supabase;
