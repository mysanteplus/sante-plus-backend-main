const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");

// Générer un mot de passe aléatoire sécurisé
function generateRandomPassword(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// Template d'email de bienvenue
function getWelcomeEmail(nom, prenom, email, password, role, url) {
  const roleName = {
    'COORDINATEUR': 'Administrateur',
    'AIDANT': 'Aidant',
    'FAMILLE': 'Membre de la famille'
  }[role] || role;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Bienvenue sur Santé Plus</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #0F172A; padding: 20px; text-align: center; border-radius: 12px 12px 0 0; }
        .header img { max-width: 120px; }
        .content { background: #fff; padding: 30px; border: 1px solid #e2e8f0; border-radius: 0 0 12px 12px; }
        .credentials { background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .btn { display: inline-block; background: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin-top: 20px; }
        .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #94a3b8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="${process.env.FRONTEND_URL}/assets/images/logo-general-text.png" alt="Santé Plus">
        </div>
        <div class="content">
          <h2>Bienvenue ${prenom} ${nom} !</h2>
          <p>Votre compte <strong>${roleName}</strong> a été créé sur la plateforme Santé Plus Services.</p>
          
          <div class="credentials">
            <p><strong>📧 Email :</strong> ${email}</p>
            <p><strong>🔑 Mot de passe temporaire :</strong> <code style="background:#fff; padding:4px 8px; border-radius:4px;">${password}</code></p>
            <p style="font-size:12px; margin-top:10px;">⚠️ Nous vous recommandons de changer votre mot de passe lors de votre première connexion.</p>
          </div>
          
          <a href="${url}" class="btn">🔗 Accéder à mon espace</a>
          
          <p style="margin-top: 20px;">Cordialement,<br><strong>L'équipe Santé Plus</strong></p>
        </div>
        <div class="footer">
          <p>Santé Plus Services - Votre partenaire de confiance</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ============================================================
// 🚀 CRÉER LE PREMIER ADMIN (sans authentification)
// ============================================================
router.post("/create-first-admin", async (req, res) => {
  const { email, password, nom, prenom, telephone } = req.body;

  if (!email || !password || !nom) {
    return res.status(400).json({ error: "Email, nom et mot de passe requis" });
  }

  try {
    // Vérifier si des admins existent déjà
    const { data: existingAdmins, error: checkErr } = await supabase
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

// ============================================================
// 🔍 VÉRIFIER SI DES ADMINS EXISTENT
// ============================================================
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

// ============================================================
// 📋 LISTER LES UTILISATEURS (Admin uniquement)
// ============================================================
router.get("/users", middleware(["COORDINATEUR"]), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 👤 CRÉER UN UTILISATEUR (Admin uniquement)
// ============================================================
router.post("/create-user", middleware(["COORDINATEUR"]), async (req, res) => {
  const { 
    email, 
    nom, 
    prenom, 
    telephone, 
    adresse, 
    role,
    competences,
    disponibilites
  } = req.body;

  if (!email || !nom || !role) {
    return res.status(400).json({ error: "Email, nom et rôle sont requis" });
  }

  try {
    // Vérifier si l'utilisateur existe déjà
    const { data: existing, error: checkErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: "Un utilisateur avec cet email existe déjà" });
    }

    // Générer un mot de passe aléatoire
    const plainPassword = generateRandomPassword();
    
    // Créer l'utilisateur dans Supabase Auth
    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email: email,
      password: plainPassword,
      email_confirm: true,
      user_metadata: {
        nom: nom,
        prenom: prenom || "",
        role: role
      }
    });

    if (authErr) throw authErr;

    // Créer le profil dans la table profiles
    const { error: profileErr } = await supabase
      .from("profiles")
      .insert({
        id: authUser.user.id,
        email: email,
        nom: nom,
        prenom: prenom || null,
        telephone: telephone || null,
        adresse: adresse || null,
        role: role,
        statut_validation: "ACTIF",
        competences: competences || [],
        disponibilites: disponibilites || null
      });

    if (profileErr) throw profileErr;

    // Envoyer l'email de bienvenue
    const frontendUrl = process.env.FRONTEND_URL;
    const emailHtml = getWelcomeEmail(nom, prenom || "", email, plainPassword, role, frontendUrl);
    
    await sendEmailAPI(email, "Bienvenue sur Santé Plus Services", emailHtml);

    console.log(`✅ Utilisateur créé: ${email} (${role})`);
    
    res.json({ 
      success: true, 
      message: `Utilisateur ${role} créé avec succès`,
      user: {
        id: authUser.user.id,
        email,
        nom,
        prenom,
        role
      }
    });

  } catch (err) {
    console.error("❌ Erreur création utilisateur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔄 RÉINITIALISER LE MOT DE PASSE
// ============================================================
router.post("/reset-password", middleware(["COORDINATEUR"]), async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "userId requis" });
  }

  try {
    const newPassword = generateRandomPassword();
    
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword
    });

    if (updateErr) throw updateErr;

    // Récupérer l'email de l'utilisateur
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("email, nom, prenom")
      .eq("id", userId)
      .single();

    if (!profileErr && profile) {
      const frontendUrl = process.env.FRONTEND_URL;
      const emailHtml = getWelcomeEmail(profile.nom, profile.prenom || "", profile.email, newPassword, "reset", frontendUrl);
      await sendEmailAPI(profile.email, "Réinitialisation de votre mot de passe", emailHtml);
    }

    res.json({ success: true, message: "Mot de passe réinitialisé et envoyé par email" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🗑️ SUPPRIMER UN UTILISATEUR
// ============================================================
router.delete("/user/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;

  try {
    // Supprimer le profil
    const { error: profileErr } = await supabase
      .from("profiles")
      .delete()
      .eq("id", id);

    if (profileErr) throw profileErr;

    // Supprimer l'utilisateur de l'auth
    const { error: authErr } = await supabase.auth.admin.deleteUser(id);
    if (authErr) console.warn("Erreur suppression auth (peut être ignorée):", authErr.message);

    res.json({ success: true, message: "Utilisateur supprimé" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
