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
            <p><strong>🔑 Mot de passe :</strong> <code style="background:#fff; padding:4px 8px; border-radius:4px;">${password}</code></p>
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
// 🚀 CRÉER UN ADMINISTRATEUR
// ============================================================
router.post("/create-first-admin", async (req, res) => {
  const { email, password, nom, prenom, telephone } = req.body;

  if (!email || !password || !nom) {
    return res.status(400).json({ error: "Email, nom et mot de passe requis" });
  }

  try {
    const { data: existingUser } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: "Un utilisateur avec cet email existe déjà" });
    }

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

    console.log(`✅ Administrateur créé: ${email}`);
    
    res.json({ 
      success: true, 
      message: "Administrateur créé avec succès."
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
// 📋 LISTER TOUS LES ADMINISTRATEURS
// ============================================================
router.get("/admins", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, nom, prenom, telephone, created_at, statut_validation")
      .eq("role", "COORDINATEUR")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 👁️ VOIR DÉTAILS D'UN ADMIN
// ============================================================
router.get("/admin/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;
  
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", id)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ✏️ MODIFIER UN ADMINISTRATEUR
// ============================================================
router.put("/admin/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;
  const { nom, prenom, telephone, email } = req.body;
  
  try {
    const updateData = {};
    if (nom !== undefined) updateData.nom = nom;
    if (prenom !== undefined) updateData.prenom = prenom;
    if (telephone !== undefined) updateData.telephone = telephone;
    if (email !== undefined) updateData.email = email;
    
    const { error } = await supabase
      .from("profiles")
      .update(updateData)
      .eq("id", id);
    
    if (error) throw error;
    res.json({ success: true, message: "Administrateur modifié avec succès" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔒 DÉSACTIVER/ACTIVER UN ADMINISTRATEUR
// ============================================================
router.patch("/admin/:id/toggle-status", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;
  const { statut_validation } = req.body;
  
  try {
    const { error } = await supabase
      .from("profiles")
      .update({ statut_validation: statut_validation })
      .eq("id", id);
    
    if (error) throw error;
    res.json({ 
      success: true, 
      message: statut_validation === "ACTIF" ? "Administrateur activé" : "Administrateur désactivé" 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔄 RÉINITIALISER LE MOT DE PASSE
// ============================================================
router.post("/admin/:id/reset-password", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;

  try {
    const newPassword = generateRandomPassword();
    
    const { error: updateErr } = await supabase.auth.admin.updateUserById(id, {
      password: newPassword
    });

    if (updateErr) throw updateErr;

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("email, nom, prenom")
      .eq("id", id)
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
// 🗑️ SUPPRIMER UN ADMINISTRATEUR
// ============================================================
router.delete("/admin/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;

  try {
    const { error: profileErr } = await supabase
      .from("profiles")
      .delete()
      .eq("id", id);

    if (profileErr) throw profileErr;

    const { error: authErr } = await supabase.auth.admin.deleteUser(id);
    if (authErr) console.warn("Erreur suppression auth:", authErr.message);

    res.json({ success: true, message: "Administrateur supprimé avec succès" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
