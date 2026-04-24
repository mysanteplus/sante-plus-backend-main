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
      return res.status(403).json({ 
        error: "Un administrateur existe déjà. Cette page n'est accessible qu'à l'installation initiale." 
      });
    }

    // Créer l'utilisateur dans Supabase Auth
    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: { 
        nom: nom, 
        prenom: prenom || "", 
        role: "COORDINATEUR" 
      }
    });

    if (authErr) throw authErr;

    // Créer le profil
    const { error: profileErr } = await supabase
      .from("profiles")
      .insert({
        id: authUser.user.id,
        email: email,
        nom: nom,
        prenom: prenom || null,
        telephone: telephone || null,
        role: "COORDINATEUR",
        statut_validation: "ACTIF"
      });

    if (profileErr) throw profileErr;

    console.log(`✅ Premier administrateur créé: ${email}`);
    
    res.json({ 
      success: true, 
      message: "Administrateur créé avec succès. Vous pouvez maintenant vous connecter."
    });

  } catch (err) {
    console.error("❌ Erreur création admin:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
