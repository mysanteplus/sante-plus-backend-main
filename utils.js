const axios = require("axios");
const supabase = require("./supabaseClient");

// ============================================================
// 🔔 NOTIFICATIONS PUSH
// ============================================================

async function sendPushNotification(userId, title, message, url = "/") {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("push_token")
      .eq("id", userId)
      .single();

    if (error) {
      console.log(`❌ Erreur récupération profil ${userId}:`, error.message);
      return false;
    }

    if (!profile?.push_token) {
      console.log(`📭 Pas de token FCM pour l'utilisateur ${userId}`);
      return false;
    }

    console.log(`📨 Envoi push à ${userId}`);

    const { sendPush } = require("./firebaseAdmin");

    await sendPush(
      profile.push_token,
      title,
      message,
      url || "/"
    );

    console.log(`✅ Push Firebase envoyé pour ${userId}`);
    return true;

  } catch (err) {
    console.error("❌ Erreur sendPushNotification:", err.code || "", err.message);
    return false;
  }
}

// ============================================================
// 📧 EMAIL VIA BREVO
// ============================================================

async function sendEmailAPI(toEmail, subject, htmlContent) {
  if (!process.env.BREVO_API_KEY) {
    console.error("❌ Erreur : Clé API Brevo manquante dans le .env");
    return false;
  }

  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          name: "Santé Plus Services",
          email: "info@mysanteplus.com", 
        },
        to: [{ email: toEmail }],
        subject: subject,
        htmlContent: htmlContent,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );
    console.log(`📩 Email envoyé avec succès à : ${toEmail}`);
    return true;
  } catch (error) {
    const errorMsg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error("❌ Échec envoi Email Brevo:", errorMsg);
    return false;
  }
}

// ============================================================
// 📅 GESTION DES ABONNEMENTS
// ============================================================

function calculateSubscriptionEndDate(startDate, durationMonths, graceDays = 5) {
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + durationMonths);
  endDate.setDate(endDate.getDate() + graceDays);
  return endDate;
}

function getDaysRemaining(endDate) {
  if (!endDate) return 0;
  const today = new Date();
  const diffTime = new Date(endDate) - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays > 0 ? diffDays : 0;
}

function isSubscriptionValid(endDate) {
  if (!endDate) return false;
  const today = new Date();
  return today <= new Date(endDate);
}

function getDurationFromPack(packId) {
  if (!packId) return 1;
  if (packId.includes('TRIMESTRIEL') || packId.includes('trimestriel')) return 3;
  if (packId.includes('SEMESTRIEL') || packId.includes('semestriel')) return 6;
  if (packId.includes('ANNUEL') || packId.includes('annuel')) return 12;
  return 1;
}

function calculateDiscountedPrice(basePrice, durationMonths) {
  if (durationMonths === 3) {
    return Math.round(basePrice * durationMonths * 0.95);
  }
  if (durationMonths === 6) {
    return Math.round(basePrice * durationMonths * 0.90);
  }
  if (durationMonths === 12) {
    return Math.round(basePrice * durationMonths * 0.85);
  }
  return basePrice * durationMonths;
}

// ============================================================
// 📡 REALTIME
// ============================================================

let realtimeChannel = null;

function getRealtimeChannel() {
  if (!realtimeChannel) {
    realtimeChannel = supabase.channel('global-channel');
    realtimeChannel.subscribe((status) => {
      console.log("📡 [Realtime Backend] Status:", status);
    });
  }
  return realtimeChannel;
}

// ============================================================
// 🔒 VÉRIFICATION RÉELLE DE L'ABONNEMENT (PRODUCTION READY)
// ============================================================

async function checkActiveSubscription(userId, userRole) {
    // ✅ Les coordinateurs et aidants ont toujours accès (ils n'ont pas d'abonnement)
    if (userRole === "COORDINATEUR" || userRole === "AIDANT") {
        return true;
    }
    
    // ✅ Si pas d'userId, refuser l'accès
    if (!userId) {
        console.error("❌ checkActiveSubscription: userId manquant");
        return false;
    }
    
    try {
        // 1. Récupérer le profil pour connaître le type de compte
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("type_compte")
            .eq("id", userId)
            .single();
        
        if (profileErr) {
            console.error(`❌ Erreur récupération profil ${userId}:`, profileErr.message);
            return false;
        }
        
        // 2. CAS : Compte AVEC patient (abonnement médical)
        if (profile?.type_compte === 'AVEC_PATIENT') {
            // Récupérer le patient lié à cette famille
            const { data: patient, error: patientErr } = await supabase
                .from("patients")
                .select("id, date_fin_abonnement, statut_paiement")
                .eq("famille_user_id", userId)
                .single();
            
            if (patientErr || !patient) {
                console.error(`❌ Patient non trouvé pour la famille ${userId}:`, patientErr?.message);
                return false;
            }
            
            // ✅ VÉRIFICATION RÉELLE :
            // 1. Le statut_paiement doit être "A jour"
            if (patient.statut_paiement !== "A jour") {
                console.log(`❌ Abonnement expiré pour ${userId}: statut_paiement = ${patient.statut_paiement}`);
                return false;
            }
            
            // 2. La date_fin_abonnement doit exister et ne pas être dépassée
            if (!patient.date_fin_abonnement) {
                console.log(`❌ Abonnement sans date de fin pour ${userId}`);
                return false;
            }
            
            const today = new Date();
            const endDate = new Date(patient.date_fin_abonnement);
            
            if (today > endDate) {
                console.log(`❌ Abonnement expiré pour ${userId}: ${endDate.toISOString().split('T')[0]}`);
                // Mettre à jour le statut en base
                await supabase
                    .from("patients")
                    .update({ statut_paiement: "Expiré" })
                    .eq("id", patient.id);
                return false;
            }
            
            console.log(`✅ Abonnement actif pour ${userId} jusqu'au ${endDate.toISOString().split('T')[0]}`);
            return true;
        }
        
        // 3. CAS : Compte SANS patient (Pack Confort)
        if (profile?.type_compte === 'SANS_PATIENT') {
            // Récupérer l'abonnement Confort actif
            const { data: abonnement, error: aboErr } = await supabase
                .from("abonnements")
                .select("date_fin_abonnement, statut")
                .eq("user_id", userId)
                .eq("type_pack", "CONFORT_247")
                .eq("statut", "Payé")
                .order("date_fin_abonnement", { ascending: false })
                .limit(1)
                .maybeSingle();
            
            if (aboErr) {
                console.error(`❌ Erreur récupération abonnement Confort pour ${userId}:`, aboErr.message);
                return false;
            }
            
            if (!abonnement) {
                console.log(`❌ Aucun Pack Confort actif pour ${userId}`);
                return false;
            }
            
            if (!abonnement.date_fin_abonnement) {
                console.log(`❌ Pack Confort sans date de fin pour ${userId}`);
                return false;
            }
            
            const today = new Date();
            const endDate = new Date(abonnement.date_fin_abonnement);
            
            if (today > endDate) {
                console.log(`❌ Pack Confort expiré pour ${userId}`);
                // Mettre à jour le profil
                await supabase
                    .from("profiles")
                    .update({ pack_confort_actif: false })
                    .eq("id", userId);
                return false;
            }
            
            console.log(`✅ Pack Confort actif pour ${userId} jusqu'au ${endDate.toISOString().split('T')[0]}`);
            return true;
        }
        
        // 4. Autres cas (type_compte non défini ou autre)
        // Par sécurité, on refuse l'accès
        console.log(`⚠️ Type de compte non reconnu pour ${userId}: ${profile?.type_compte || 'non défini'}`);
        return false;
        
    } catch (err) {
        console.error(`❌ Erreur checkActiveSubscription pour ${userId}:`, err.message);
        return false;
    }
}

// ============================================================
// 📤 EXPORTS
// ============================================================

module.exports = { 
  sendEmailAPI, 
  sendPushNotification,
  calculateSubscriptionEndDate,
  getDaysRemaining,
  isSubscriptionValid,
  getDurationFromPack,
  getRealtimeChannel,
  calculateDiscountedPrice,
  checkActiveSubscription 
};
