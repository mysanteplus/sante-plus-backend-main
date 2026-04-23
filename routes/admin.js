const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendEmailAPI } = require("../utils");

// ============================================================
// TEMPLATES D'EMAILS
// ============================================================

// Email par défaut
function getDefaultEmailHtml(nom, role) {
    const roleText = role === 'FAMILLE' 
        ? "Vous pouvez dès à présent suivre le journal de soins de votre proche."
        : "Vous pouvez maintenant consulter votre planning d'interventions.";

    const logoSrc = `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/assets/images/logo-general-text.png`;

    return `
        <div style="background-color: #F8FAFC; padding: 50px 20px; font-family: 'Helvetica Neue', sans-serif;">
            <div style="max-width: 600px; margin: auto; background: white; border-radius: 32px; overflow: hidden; box-shadow: 0 40px 100px rgba(0,0,0,0.08);">
                <div style="background: #0F172A; padding: 40px; text-align: center;">
                    <img src="${logoSrc}" style="width: 60px;">
                    <h1 style="color: white; font-size: 16px; letter-spacing: 4px;">Santé Plus Services</h1>
                </div>
                <div style="padding: 60px 50px;">
                    <h2 style="color: #0F172A; font-size: 24px;">Compte Activé !</h2>
                    <p style="color: #64748B;">Bonjour <b>${nom}</b>,</p>
                    <p style="color: #64748B;">Votre compte a été activé avec succès.</p>
                    <p style="color: #64748B;">${roleText}</p>
                    <div style="text-align: center; margin-top: 45px;">
                        <a href="https://app.mysanteplus.com/" 
                           style="background: #10B981; color: white; padding: 20px 40px; border-radius: 18px; text-decoration: none; font-weight: 800;">
                            Accéder à mon espace
                        </a>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Email avec message personnalisé
function getEmailWithCustomMessage(nom, role, customMessage) {
    const roleText = role === 'FAMILLE' 
        ? "Vous pouvez dès à présent suivre le journal de soins de votre proche."
        : "Vous pouvez maintenant consulter votre planning d'interventions.";

    const logoSrc = `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/assets/images/logo-general-text.png`;

    return `
        <div style="background-color: #F8FAFC; padding: 50px 20px; font-family: 'Helvetica Neue', sans-serif;">
            <div style="max-width: 600px; margin: auto; background: white; border-radius: 32px; overflow: hidden; box-shadow: 0 40px 100px rgba(0,0,0,0.08);">
                <div style="background: #0F172A; padding: 40px; text-align: center;">
                    <img src="${logoSrc}" style="width: 60px;">
                    <h1 style="color: white; font-size: 16px; letter-spacing: 4px;">Santé Plus Services</h1>
                </div>
                <div style="padding: 60px 50px;">
                    <!-- ⭐ MESSAGE PERSONNALISÉ EN HAUT ⭐ -->
                    <div style="background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 20px; border-radius: 12px; margin-bottom: 30px;">
                        <p style="color: #92400E; font-size: 14px; margin: 0; font-style: italic;">
                            📝 <strong>Message du coordinateur :</strong><br>
                            ${customMessage.replace(/\n/g, '<br>')}
                        </p>
                    </div>
                    
                    <h2 style="color: #0F172A; font-size: 24px;">Compte Activé !</h2>
                    <p style="color: #64748B;">Bonjour <b>${nom}</b>,</p>
                    <p style="color: #64748B;">Votre compte a été activé avec succès.</p>
                    <p style="color: #64748B;">${roleText}</p>
                    <div style="text-align: center; margin-top: 45px;">
                        <a href="https://app.mysanteplus.com/" 
                           style="background: #10B981; color: white; padding: 20px 40px; border-radius: 18px; text-decoration: none; font-weight: 800;">
                            Accéder à mon espace
                        </a>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * ✅ VALIDER UN NOUVEAU MEMBRE (Coordinateur)
 */
router.post("/validate-member", middleware(['COORDINATEUR']), async (req, res) => {
    const { user_id, role, email, nom, notes } = req.body;

    try {
        console.log(`🚀 Activation du compte : ${email} (${role})`);

        // 1. ACTIVER LE PROFIL
        const { error: profileErr } = await supabase
            .from("profiles")
            .update({ statut_validation: 'ACTIF' })
            .eq("id", user_id);

        if (profileErr) throw profileErr;

        // 2. ACTIVER LE PATIENT LIÉ (si Famille)
        if (role === 'FAMILLE') {
            const { error: patientErr } = await supabase
                .from("patients")
                .update({ statut_validation: 'ACTIF' })
                .eq("famille_user_id", user_id);
            
            if (patientErr) {
                console.warn("⚠️ Erreur activation patient:", patientErr.message);
            }
        }

        // 3. CONSTRUCTION DE L'EMAIL
        let emailHtml;
        if (notes && notes.trim() !== '') {
            emailHtml = getEmailWithCustomMessage(nom, role, notes);
        } else {
            emailHtml = getDefaultEmailHtml(nom, role);
        }

        // 4. ENVOI DE L'EMAIL
        try {
            await sendEmailAPI(email, "Activation de votre compte Santé Plus", emailHtml);
            console.log(`✅ Email envoyé à ${email}`);
        } catch (mailErr) {
            console.error("⚠️ Erreur envoi email:", mailErr.message);
        }

        res.json({ status: "success", message: "Compte activé avec succès" });

    } catch (err) {
        console.error("❌ Erreur activation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 🔍 LISTER LES INSCRIPTIONS EN ATTENTE
 */
router.get("/pending-registrations", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("profiles")
            .select(`
                id, nom, email, role, telephone, created_at,
                patients:patients!famille_user_id (id, nom_complet, formule)
            `)
            .eq("statut_validation", "EN_ATTENTE");

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
