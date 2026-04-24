const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { sendEmailAPI } = require("../utils");  // ← AJOUTER

// Template d'email de bienvenue
function getWelcomeEmail(email, password, nom, prenom) {
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
          <p>Votre compte administrateur a été créé sur la plateforme Santé Plus Services.</p>
          
          <div class="credentials">
            <p><strong>📧 Email :</strong> ${email}</p>
            <p><strong>🔑 Mot de passe :</strong> <code style="background:#fff; padding:4px 8px; border-radius:4px;">${password}</code></p>
            <p style="font-size:12px; margin-top:10px;">⚠️ Nous vous recommandons de changer votre mot de passe lors de votre première connexion.</p>
          </div>
          
          <a href="${process.env.FRONTEND_URL}" class="btn">🔗 Accéder à mon espace</a>
          
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
    console.error("❌ Erreur has-admin:", err);
    res.status(500).json({ error: err.message });
  }
});

// Créer le premier admin
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
      return res.status(403).json({ error: "Un administrateur existe déjà" });
    }

    // Créer l'utilisateur
    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: { nom, prenom: prenom || "", role: "COORDINATEUR" }
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

    // ✅ ENVOYER L'EMAIL
    try {
      const emailHtml = getWelcomeEmail(email, password, nom, prenom || "");
      await sendEmailAPI(email, "Bienvenue sur Santé Plus Services", emailHtml);
      console.log(`📧 Email envoyé à ${email}`);
    } catch (emailErr) {
      console.error("❌ Erreur envoi email:", emailErr.message);
      // Non bloquant - le compte est quand même créé
    }

    res.json({ success: true, message: "Administrateur créé avec succès. Un email a été envoyé." });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
