const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");

// ============================================================
// TEMPLATE EMAIL
// ============================================================

function getWelcomeEmail(email, password, nom, prenom, role) {
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

// ============================================================
// 1. VÉRIFIER SI DES ADMINS EXISTENT
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
    console.error("❌ Erreur has-admin:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 2. CRÉER LE PREMIER ADMINISTRATEUR
// ============================================================
router.post("/create-first-admin", async (req, res) => {
  const { email, password, nom, prenom, telephone } = req.body;

  if (!email || !password || !nom) {
    return res.status(400).json({ error: "Email, nom et mot de passe requis" });
  }

  try {
    const { data: existingAdmins } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "COORDINATEUR")
      .limit(1);

    if (existingAdmins && existingAdmins.length > 0) {
      return res.status(403).json({ error: "Un administrateur existe déjà" });
    }

    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: { nom, prenom: prenom || "", role: "COORDINATEUR" }
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

    try {
      const emailHtml = getWelcomeEmail(email, password, nom, prenom || "", "COORDINATEUR");
      await sendEmailAPI(email, "Bienvenue sur Santé Plus Services", emailHtml);
      console.log(`📧 Email envoyé à ${email}`);
    } catch (emailErr) {
      console.error("❌ Erreur envoi email:", emailErr.message);
    }

    res.json({ success: true, message: "Administrateur créé avec succès. Un email a été envoyé." });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 3. CRÉER UN UTILISATEUR (Admin)
// ============================================================
router.post("/create-user", middleware(["COORDINATEUR"]), async (req, res) => {
  const { email, password, nom, prenom, telephone, adresse, role, competences, disponibilites } = req.body;

  if (!email || !nom || !role) {
    return res.status(400).json({ error: "Email, nom et rôle sont requis" });
  }

  try {
    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: "Un utilisateur avec cet email existe déjà" });
    }

    const finalPassword = password || generateRandomPassword();

    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email: email,
      password: finalPassword,
      email_confirm: true,
      user_metadata: { nom, prenom: prenom || "", role }
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
        adresse: adresse || null,
        role: role,
        statut_validation: "ACTIF",
        competences: competences || [],
        disponibilites: disponibilites || null
      });

    if (profileErr) throw profileErr;

    try {
      const emailHtml = getWelcomeEmail(email, finalPassword, nom, prenom || "", role);
      await sendEmailAPI(email, "Bienvenue sur Santé Plus Services", emailHtml);
      console.log(`📧 Email envoyé à ${email}`);
    } catch (emailErr) {
      console.error("❌ Erreur envoi email:", emailErr.message);
    }

    res.json({ success: true, message: `Compte ${role} créé avec succès` });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4. RÉCUPÉRER TOUS LES PROFILS (admin)
// ============================================================
router.get("/all-profiles", middleware(["COORDINATEUR"]), async (req, res) => {
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
// 5. RÉCUPÉRER UN PROFIL COMPLET
// ============================================================
router.get("/profile/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;
  
  try {
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", id)
      .single();
    
    if (profileErr) throw profileErr;
    
    let response = { ...profile };
    
    if (profile.role === "FAMILLE") {
      const { data: patients, error: patientsErr } = await supabase
        .from("patients")
        .select("*")
        .eq("famille_user_id", id);
      
      if (!patientsErr) response.patients = patients;
    }
    
    if (profile.role === "AIDANT") {
      const { data: assignments, error: assignErr } = await supabase
        .from("planning")
        .select(`
          id,
          patient_id,
          patient:patients(id, nom_complet, adresse, formule),
          date_prevue,
          statut,
          est_actif
        `)
        .eq("aidant_id", id)
        .eq("est_actif", true);
      
      if (!assignErr) response.assignments = assignments;
      
      const { data: stats, error: statsErr } = await supabase
        .from("visites")
        .select("statut")
        .eq("aidant_id", id);
      
      if (!statsErr) {
        response.stats = {
          total: stats.length,
          validees: stats.filter(v => v.statut === "Validé").length,
          en_attente: stats.filter(v => v.statut === "En attente").length
        };
      }
    }
    
    res.json(response);
    
  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 6. METTRE À JOUR UN PROFIL
// ============================================================
router.put("/profile/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;
  const { nom, prenom, email, telephone, adresse, competences, disponibilites, statut_validation } = req.body;
  
  try {
    const updateData = {};
    if (nom !== undefined) updateData.nom = nom;
    if (prenom !== undefined) updateData.prenom = prenom;
    if (email !== undefined) updateData.email = email;
    if (telephone !== undefined) updateData.telephone = telephone;
    if (adresse !== undefined) updateData.adresse = adresse;
    if (competences !== undefined) updateData.competences = competences;
    if (disponibilites !== undefined) updateData.disponibilites = disponibilites;
    if (statut_validation !== undefined) updateData.statut_validation = statut_validation;
    
    const { error } = await supabase
      .from("profiles")
      .update(updateData)
      .eq("id", id);
    
    if (error) throw error;
    res.json({ success: true });
    
  } catch (err) {
    console.error("❌ Erreur mise à jour:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 7. RÉCUPÉRER UN PATIENT COMPLET
// ============================================================
router.get("/patient/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;
  
  try {
    const { data: patient, error } = await supabase
      .from("patients")
      .select(`
        *,
        famille:famille_user_id(id, nom, prenom, email, telephone),
        coordinateur:coordinateur_id(id, nom)
      `)
      .eq("id", id)
      .single();
    
    if (error) throw error;
    res.json(patient);
    
  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 8. RÉCUPÉRER TOUS LES PATIENTS (admin)
// ============================================================
router.get("/all-patients", middleware(["COORDINATEUR"]), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("patients")
      .select(`
        *,
        famille:famille_user_id(id, nom, prenom, email)
      `)
      .order("created_at", { ascending: false });
    
    if (error) throw error;
    res.json(data);
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 9. RÉINITIALISER LE MOT DE PASSE
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

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("email, nom, prenom")
      .eq("id", userId)
      .single();

    if (!profileErr && profile) {
      const emailHtml = getWelcomeEmail(profile.email, newPassword, profile.nom, profile.prenom || "", "reset");
      await sendEmailAPI(profile.email, "Réinitialisation de votre mot de passe", emailHtml);
    }

    res.json({ success: true, message: "Mot de passe réinitialisé et envoyé par email" });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 10. SUPPRIMER UN UTILISATEUR
// ============================================================
router.delete("/user/:id", middleware(["COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;

  try {
    const { error: profileErr } = await supabase
      .from("profiles")
      .delete()
      .eq("id", id);

    if (profileErr) throw profileErr;

    const { error: authErr } = await supabase.auth.admin.deleteUser(id);
    if (authErr) console.warn("Erreur suppression auth:", authErr.message);

    res.json({ success: true, message: "Utilisateur supprimé" });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// UTILITAIRE: GÉNÉRER MOT DE PASSE ALÉATOIRE
// ============================================================
function generateRandomPassword(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

module.exports = router;
