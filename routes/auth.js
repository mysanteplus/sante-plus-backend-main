const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const JWT_SECRET = process.env.JWT_SECRET;

// ============================================================
// 1. CONNEXION SÉCURISÉE (Avec 2FA optionnel pour Coordinateur)
// ============================================================
// 1. CONNEXION SÉCURISÉE (Version Unique)
router.post("/login", async (req, res) => {
  try {
    const email = (req.body.email || req.body.u || "").toLowerCase().trim();
    const password = req.body.password || req.body.p;

    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    // A. Authentification Supabase
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (authErr) return res.status(401).json({ error: "Identifiants invalides" });

    // B. Récupération du Profil
    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", authData.user.id)
      .single();

    if (profErr || !profile) {
      console.error("ERREUR LECTURE PROFIL SUPABASE :", profErr);
      return res.status(404).json({ error: "Détails du profil introuvables. Contactez l'admin." });
    }

    // C. Vérification du statut_validation
    if (profile.statut_validation === 'EN_ATTENTE') {
      return res.status(403).json({ error: "Votre compte est en attente de validation." });
    }

    const userRole = (profile.role || "AIDANT").toUpperCase();

    // C. Logique 2FA (Temporairement désactivée pour le développement)
    const isDevMode = true; // 👈 Change en 'false' pour réactiver le 2FA plus tard

    if (userRole === "COORDINATEUR" && !isDevMode) {
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 10 * 60000).toISOString();

      await supabase.from("profiles").update({ reset_code: otpCode, reset_expires: expires }).eq("id", authData.user.id);

        const logoSrc = `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/assets/images/logo-general-icon.png`;

      const emailHtml = `
      <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px;">
          <div style="background-color: #0f172a; padding: 20px; text-align: center;">
              <img src="${logoSrc}" style="width: 40px; margin-bottom: 10px;">
              <h2 style="color: #ffffff; margin: 0;">SÉCURITÉ SANTÉ PLUS</h2>
          </div>
          <div style="padding: 30px; text-align: center;">
              <h2>Code de vérification</h2>
              <p>Bonjour <b>${profile.nom}</b>, voici votre code sécurisé :</p>
              <div style="background: #f1f5f9; padding: 20px; margin: 25px 0; font-size: 32px; font-weight: 900; letter-spacing: 10px; color: #16a34a; border-radius: 12px;">
                  ${otpCode}
              </div>
          </div>
      </div>`;  


      await sendEmailAPI(email, "Code de sécurité Santé Plus", emailHtml);
      
      return res.json({ status: "require_2fa", email: email });
    }

    // E. Connexion directe pour les autres rôles
    const token = jwt.sign({ userId: authData.user.id, role: userRole }, JWT_SECRET, { expiresIn: "24h" });
    return res.json({ 
        status: "success", 
        token, 
        role: userRole, 
        nom: profile.nom,
        photo_url: profile.photo_url || null,  
        user_id: authData.user.id               
    });
  } catch (err) {
    console.error("Login Crash:", err.message);
    res.status(500).json({ error: "Erreur technique serveur" });
  }
});


// Demander la réinitialisation du mot de passe
// Mot de passe oublié - Demander réinitialisation
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  console.log("📧 Demande reset pour:", email);

  if (!email) {
    return res.status(400).json({ error: "Email requis" });
  }

  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, email, nom")
      .eq("email", email)
      .single();

    if (error || !profile) {
      // Ne pas révéler si l'email existe (sécurité)
      return res.json({ success: true, message: "Email envoyé" });
    }

    // Générer un token unique
    const crypto = require("crypto");
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString(); // 1 heure

    console.log("🔑 Token généré:", resetToken.substring(0, 20) + "...");
    console.log("⏰ Expiration:", expires);

    // Stocker le token
    await supabase
      .from("profiles")
      .update({ reset_token: resetToken, reset_expires: expires })
      .eq("id", profile.id);

    // Construire le lien
    const frontendUrl = process.env.FRONTEND_URL || "https://app.mysanteplus.com";
    const resetLink = `${frontendUrl}/reset-password.html?token=${resetToken}`;

    // Email HTML
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; padding: 20px;">
        <h2 style="color: #10B981;">Réinitialisation du mot de passe</h2>
        <p>Bonjour ${profile.nom || ''},</p>
        <p>Cliquez sur le lien ci-dessous pour réinitialiser votre mot de passe :</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Réinitialiser</a>
        </div>
        <p style="font-size: 12px; color: #666;">Ce lien expire dans 1 heure.</p>
        <hr>
        <p style="font-size: 11px;">Santé Plus Services</p>
      </div>
    `;

    await sendEmailAPI(email, "Réinitialisation mot de passe - Santé Plus", emailHtml);

    res.json({ success: true, message: "Email envoyé !" });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});


// Réinitialiser le mot de passe
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  console.log("🔵 Token reçu:", token?.substring(0, 20) + "...");

  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token et mot de passe requis" });
  }

  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("reset_token", token)
      .gt("reset_expires", new Date().toISOString())
      .single();

    if (error || !profile) {
      console.error("❌ Token invalide ou expiré");
      return res.status(400).json({ error: "Token invalide ou expiré" });
    }

    console.log("✅ Profil trouvé:", profile.id);

    // Mettre à jour le mot de passe
    const { error: updateError } = await supabase.auth.admin.updateUserById(profile.id, {
      password: newPassword
    });

    if (updateError) throw updateError;



    
    // Supprimer le token
    await supabase
      .from("profiles")
      .update({ reset_token: null, reset_expires: null })
      .eq("id", profile.id);

    res.json({ success: true, message: "Mot de passe mis à jour" });

  } catch (err) {
    console.error("❌ Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 2. VÉRIFICATION DU CODE 2FA
// ============================================================
router.post("/verify-2fa", async (req, res) => {
  try {
    const email = String(req.body.u || req.body.email || "").toLowerCase().trim();
    const codeSaisi = String(req.body.code || "").trim();

    const { data: profile } = await supabase
        .from("profiles")
        .select("id, reset_code, reset_expires, role, nom")
        .eq("email", email) 
        .single();

    if (!profile) return res.status(401).json({ status: "error", message: "Session expirée." });

    const codeEnBase = profile.reset_code ? String(profile.reset_code).trim() : null;
    
    if (!codeEnBase || codeSaisi !== codeEnBase) {
      return res.status(401).json({ status: "error", message: "Code de sécurité incorrect." });
    }

    const maintenantMS = Date.now();
    const expirationMS = new Date(profile.reset_expires).getTime();
    
    if (maintenantMS > (expirationMS + 300000)) { 
      return res.status(401).json({ status: "error", message: "Ce code a expiré." });
    }

    await supabase.from("profiles").update({ reset_code: null, reset_expires: null }).eq("id", profile.id);

    const token = jwt.sign({ userId: profile.id, role: profile.role }, JWT_SECRET, { expiresIn: "24h" });

      return res.json({ 
          status: "success", 
          token, 
          role: profile.role, 
          nom: profile.nom,
          photo_url: profile.photo_url || null,  
          user_id: profile.id                     
      });
  } catch (err) {
    res.status(500).json({ status: "error", message: "Erreur technique serveur." });
  }
});

// ============================================================
// 3. MOT DE PASSE OUBLIÉ (Demander un code)
// ============================================================
router.all("/request-password-reset", async (req, res) => {
    const email = req.body.email ? req.body.email.toLowerCase().trim() : "";
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60000).toISOString(); // Expire dans 15 min
  
    // On met à jour le code dans la table "profiles"
    const { data: profile, error } = await supabase
      .from("profiles")
      .update({ reset_code: code, reset_expires: expires })
      .eq("email", email)
      .select("nom")
      .maybeSingle();
  
if (profile) {
  const logoSrc = `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/assets/images/logo-general-icon.png`;
  
  const html = `
    <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px;">
        <div style="background-color: #0f172a; padding: 20px; text-align: center;">
            <img src="${logoSrc}" style="width: 40px; margin-bottom: 10px;">
            <h2 style="color: #ffffff; margin: 0; font-size: 16px;">SANTÉ PLUS SERVICES</h2>
        </div>
        <div style="padding: 30px; text-align: center;">
            <h2 style="color: #1e293b;">Réinitialisation</h2>
            <p>Bonjour <b>${profile.nom}</b>,</p>
            <p>Voici votre code de vérification pour changer votre mot de passe :</p>
            <div style="background: #f1f5f9; padding: 15px; margin: 20px 0; font-size: 28px; font-weight: 900; letter-spacing: 8px; color: #2563eb; text-align: center; border-radius: 10px;">
                ${code}
            </div>
            <p style="font-size: 12px; color: #64748b;">Ce code expirera dans 15 minutes.</p>
        </div>
    </div>`;

  await sendEmailAPI(email, "Réinitialisation - Santé Plus", html);
}
  
    // On répond succès même si l'email n'existe pas (Sécurité anti-scan)
    return res.json({ status: "success", message: "Procédure lancée." });
});

// ============================================================
// 4. MOT DE PASSE OUBLIÉ (Changer le mot de passe)
// ============================================================
router.all("/reset-password", async (req, res) => {
    const { email, code, newPassword } = req.body;
    const cleanEmail = (email || "").toLowerCase().trim();
  
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", cleanEmail)
      .eq("reset_code", code)
      .gt("reset_expires", new Date().toISOString())
      .maybeSingle();
  
    if (!profile) return res.status(400).json({ error: "Code invalide ou expiré." });
  
    // Modification du mot de passe dans Supabase Auth (Nécessite Service Role Key)
    const { error: updateAuthErr } = await supabase.auth.admin.updateUserById(
        profile.id, 
        { password: newPassword }
    );

    if (updateAuthErr) return res.status(500).json({ error: "Erreur lors du changement de mot de passe." });

    // Nettoyage du code
    await supabase.from("profiles").update({ reset_code: null, reset_expires: null }).eq("id", profile.id);
  
    return res.json({ status: "success" });
});

// ============================================================
// 5. INSCRIPTION DUO : FAMILLE + PATIENT (Public)
// ============================================================
router.post("/register-family-patient", async (req, res) => {
    const { 
        email, password, nom_famille, prenom_famille, tel_famille, lien_parente, ville_payeur,
        nom_patient, prenom_patient, age_patient, sexe_patient, adresse_patient, tel_patient,
        contact_urgence, contact_urgence_tel, pathologies, traitements, allergies, notes_medicales, formule 
    } = req.body;
    
    const cleanEmail = (email || "").toLowerCase().trim();
    const nomCompletFamille = `${prenom_famille || ''} ${nom_famille}`.trim();
    const nomCompletPatient = `${prenom_patient || ''} ${nom_patient}`.trim();

    // ✅ Traitement des pathologies
    let pathologiesArray = [];
    if (pathologies) {
        if (Array.isArray(pathologies)) {
            pathologiesArray = pathologies;
        } else if (typeof pathologies === 'string') {
            pathologiesArray = pathologies.split(',').map(s => s.trim());
        }
    }

    try {
        console.log("📝 1. Création du compte Auth...");
        const { data: auth, error: authErr } = await supabase.auth.signUp({ 
            email: cleanEmail, 
            password: password 
        });
        if (authErr) throw authErr;
        console.log("✅ Auth créé:", auth.user.id);

        // Insertion dans profiles
        console.log("📝 2. Insertion dans profiles...");
        const { error: profileErr } = await supabase.from("profiles").insert({
            id: auth.user.id, 
            nom: nomCompletFamille,
            prenom: prenom_famille,
            telephone: tel_famille,
            email: cleanEmail,
            adresse: ville_payeur,
            role: 'FAMILLE', 
            statut_validation: 'EN_ATTENTE'
        });
        if (profileErr) {
            console.error("❌ Erreur profile:", profileErr);
            throw profileErr;
        }
        console.log("✅ Profile famille créé");

        // Insertion dans patients
        console.log("📝 3. Insertion dans patients...");
        const patientData = {
            nom_complet: nomCompletPatient,
            prenom: prenom_patient,
            nom: nom_patient,
            age: age_patient,
            sexe: sexe_patient,
            adresse: adresse_patient,
            telephone: tel_patient,
            contact_urgence: contact_urgence,
            contact_urgence_tel: contact_urgence_tel,
            pathologies: pathologiesArray,
            traitements: traitements || null,
            allergies: allergies || null,
            notes_medicales: notes_medicales || null,
            formule: formule || null,
            famille_user_id: auth.user.id,
            statut_paiement: 'A jour',
            statut_validation: 'EN_ATTENTE',
            categorie_service: req.body.categorie || 'SENIOR'  
        };
        
        console.log("📦 Données patient:", JSON.stringify(patientData, null, 2));
        
        const { error: patientErr, data: patientResult } = await supabase
            .from("patients")
            .insert(patientData)
            .select();
            
        if (patientErr) {
            console.error("❌ Erreur patient:", patientErr);
            throw patientErr;
        }
        console.log("✅ Patient créé:", patientResult);

                // Email de confirmation
        const isMaman = formule === 'MATERNITE' || (req.body.categorie === 'MAMAN_BEBE');
        const logoSrc = isMaman 
            ? `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/assets/images/logo-maman-text.png`
            : `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/assets/images/logo-general-text.png`;
        
        // Email de confirmation avec logo
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <img src="${logoSrc}" style="width: 100px; height: auto;">
                </div>
                <h2 style="color: #10B981;">Bienvenue chez Santé Plus !</h2>
                <p>Bonjour ${nomCompletFamille},</p>
                <p>Nous avons bien reçu votre demande d'admission pour le suivi de <strong>${nomCompletPatient}</strong>.</p>
                <p>Un coordinateur va valider votre dossier sous 24h.</p>
                <hr>
                <p style="font-size: 12px; color: #64748B;">Santé Plus Services - Bénin</p>
            </div>
        `;
        await sendEmailAPI(cleanEmail, "Votre demande d'inscription - Santé Plus", html);

        res.json({ status: "success", message: "Inscription enregistrée" });
        
    } catch (err) { 
        console.error("❌ Erreur Inscription:", err);
        res.status(500).json({ error: err.message, details: err.details }); 
    }
});
// ============================================================
// 6. CRÉATION D'EMPLOYÉ PAR LE COORDINATEUR (Avec envoi d'email)
// ============================================================
router.post("/create-member", middleware(["COORDINATEUR"]), async (req, res) => {
    // Récupérer tous les champs
    const { 
        email, 
        password, 
        nom, 
        prenom, 
        telephone, 
        adresse, 
        competences, 
        disponibilites, 
        role 
    } = req.body;

    try {
        console.log(`[RH] Création du collaborateur : ${email}`);

        // 1. Création dans Supabase Auth
        const { data: userData, error: authErr } = await supabase.auth.admin.createUser({
            email: email,
            password: password,
            email_confirm: true
        });
        if (authErr) throw authErr;

        // 2. Ajout dans la table Profiles avec TOUS les champs
        const { error: profErr } = await supabase.from("profiles").insert([{
            id: userData.user.id,
            nom: nom,
            prenom: prenom || null,
            telephone: telephone || null,
            email: email,
            adresse: adresse || null,
            competences: competences || [],
            disponibilites: disponibilites || null,
            role: role,
            statut_validation: 'ACTIF'
        }]);
        if (profErr) throw profErr;

        // 3. ENVOI DE L'EMAIL
        const nomComplet = `${prenom || ''} ${nom}`.trim();
     const logoSrc = `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/assets/images/logo-general-text.png`;

const emailHtml = `
    <div style="background-color: #F8FAFC; padding: 40px; font-family: sans-serif;">
        <div style="max-width: 600px; margin: auto; background: white; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.05);">
            <div style="background: #0F172A; padding: 30px; text-align: center;">
                <img src="${logoSrc}" style="width: 60px; margin-bottom: 10px;">
                <h1 style="color: white; margin: 0; font-size: 18px; letter-spacing: 2px;">SANTÉ PLUS SERVICES</h1>
            </div>
            <div style="padding: 40px;">
                <h2 style="color: #0F172A; font-size: 22px;">Bienvenue dans l'équipe !</h2>
                <p style="color: #64748B;">Bonjour <b>${nomComplet}</b>, votre compte ${role} a été créé avec succès.</p>
                
                <div style="background: #F1F5F9; border-left: 4px solid #10B981; padding: 20px; border-radius: 12px; margin: 25px 0;">
                    <p style="margin: 0; color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: bold;">Vos identifiants de connexion</p>
                    <p style="margin: 10px 0 5px 0; font-size: 15px;">Email : <b>${email}</b></p>
                    <p style="margin: 0; font-size: 15px;">Mot de passe : <b style="color: #10B981;">${password}</b></p>
                </div>
                
                ${adresse ? `<p style="font-size: 12px; color: #64748B;">📍 Adresse: ${adresse}</p>` : ''}
                ${competences?.length ? `<p style="font-size: 12px; color: #64748B;">🩺 Compétences: ${competences.join(', ')}</p>` : ''}
                
                <a href="https://app.mysanteplus.com//" style="display: block; background: #0F172A; color: white; padding: 15px; text-align: center; text-decoration: none; border-radius: 12px; font-weight: bold;">Accéder à mon espace</a>
            </div>
        </div>
    </div>
`;
        try {
            await sendEmailAPI(email, "Vos accès collaborateurs - Santé Plus", emailHtml);
            console.log("✅ Mail RH envoyé avec succès !");
        } catch (mailError) {
            console.warn("⚠️ Le compte est créé mais l'email n'a pas pu être envoyé.");
        }

        res.json({ status: "success" });
    } catch (err) { 
        console.error("❌ Erreur Create Member:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// ============================================================
// 7. ENREGISTRER UN APPAREIL POUR LES NOTIFICATIONS PUSH
// ============================================================
router.post("/subscribe-push", middleware(), async (req, res) => {
  const { endpoint, p256dh, auth } = req.body;
  if (!endpoint) return res.status(400).json({ error: "Endpoint manquant" });

  try {
    await supabase.from("push_subscriptions").upsert({
        user_id: req.user.userId, endpoint, p256dh, auth
    }, { onConflict: "endpoint" });

    res.status(201).json({ status: "success" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 8. LISTER LES PROFILS (Pour assignation Familles/Aidants)
// ============================================================
router.get("/profiles", middleware(["COORDINATEUR"]), async (req, res) => {
    const { role } = req.query;
    let query = supabase.from("profiles").select("id, nom, email");
    
    if (role) {
        query = query.eq("role", role);
    }
    
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});


/**
 * 📸 Mettre à jour la photo de profil
 */
router.post("/update-photo", middleware(), upload.single('photo'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Aucune photo" });
        
        const fileName = `profiles/${req.user.userId}_${Date.now()}.jpg`;
        await supabase.storage.from("photos").upload(fileName, file.buffer, {
            contentType: 'image/jpeg',
            upsert: true
        });
        
        const { data: urlData } = supabase.storage.from("photos").getPublicUrl(fileName);
        const photo_url = urlData.publicUrl;
        
        await supabase.from("profiles").update({ photo_url }).eq("id", req.user.userId);
        
        res.json({ photo_url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📋 Récupérer le profil utilisateur
 */
router.get("/profile/:userId", middleware(), async (req, res) => {
    const { userId } = req.params;
    
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();
    
    if (error) return res.status(404).json({ error: "Profil non trouvé" });
    res.json(data);
});

/**
 * ✏️ Mettre à jour le profil
 */
router.put("/update-profile", middleware(), async (req, res) => {
    const { nom, email, telephone } = req.body;
    
    const { error } = await supabase
        .from("profiles")
        .update({ nom, email, telephone })
        .eq("id", req.user.userId);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});

/**
 * 👨‍⚕️ Mettre à jour les infos aidant
 */
router.put("/update-aidant-info", middleware(["AIDANT"]), async (req, res) => {
    const { competences, disponibilites } = req.body;
    
    const { error } = await supabase
        .from("profiles")
        .update({ competences, disponibilites })
        .eq("id", req.user.userId);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});




router.put("/update-profile-full", middleware(), async (req, res) => {
    const { prenom, nom, email, telephone, adresse } = req.body;
    
    console.log("📝 Mise à jour profil:", { prenom, nom, email, telephone, adresse });
    
    // ✅ Mise à jour simple - sans nom_complet
    const updateData = {};
    if (prenom !== undefined) updateData.prenom = prenom || null;
    if (nom !== undefined) updateData.nom = nom || null;
    if (email !== undefined) updateData.email = email || null;
    if (telephone !== undefined) updateData.telephone = telephone || null;
    if (adresse !== undefined) updateData.adresse = adresse || null;
    
    const { error } = await supabase
        .from("profiles")
        .update(updateData)
        .eq("id", req.user.userId);
    
    if (error) {
        console.error("❌ Erreur update-profile-full:", error);
        return res.status(500).json({ error: error.message });
    }
    
    console.log("✅ Profil mis à jour avec succès");
    res.json({ status: "success" });
});

router.put("/update-aidant-full-info", middleware(["AIDANT"]), async (req, res) => {
    const { competences, disponibilites, adresse } = req.body;
    
    const { error } = await supabase
        .from("profiles")
        .update({ competences, disponibilites, adresse })
        .eq("id", req.user.userId);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});
module.exports = router;
