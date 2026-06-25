require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// ✅ Utiliser les variables d'environnement
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

// ✅ Vérification des variables
if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Erreur: SUPABASE_URL ou SUPABASE_SERVICE_KEY manquantes dans .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

console.log(`✅ Supabase connecté: ${supabaseUrl}`);

module.exports = supabase;
