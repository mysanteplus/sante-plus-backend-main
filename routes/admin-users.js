const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

// Vérifier si des admins existent
router.get("/has-admin", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "COORDINATEUR")
      .limit(1);

    if (error) throw error;
    res.json({ hasAdmin: data && data.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Créer le premier admin (sans authentification)
router.post("/create-first-admin", async (req, res) => {
  console.log("📥 Requête reçue:", req.body);
  console.log("🔑 Supabase service key présente:", !!process.env.SUPABASE_SERVICE_KEY);
  const { email, password, nom, prenom, telephone } = req.body;

  if (!email || !password || !nom) {
    return res.status(400).json({ error: "Email, nom et mot de passe requis" });
  }

  try {
    // Vérifier si des admins existent déjà
    const { data: existingAdmins } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "COORDINATEUR")
      .limit(1);

    if (existingAdmins && existingAdmins.length > 0) {
      return res.status(403).json({ error: "Un administrateur existe déjà" });
    }

    // 1. Créer l'utilisateur avec l'API Auth (en utilisant la clé service_role)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: { nom, prenom, role: "COORDINATEUR" }
    });

    if (authError) {
      console.error("Auth error:", authError);
      return res.status(500).json({ error: authError.message });
    }

    // 2. Créer le profil
    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: authData.user.id,
        email: email,
        nom: nom,
        prenom: prenom || null,
        telephone: telephone || null,
        role: "COORDINATEUR",
        statut_validation: "ACTIF"
      });

    if (profileError) {
      console.error("Profile error:", profileError);
      return res.status(500).json({ error: profileError.message });
    }

    res.json({ success: true, message: "Administrateur créé avec succès" });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
