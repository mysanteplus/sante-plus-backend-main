 
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
// 🔒 VÉRIFICATION ABONNEMENT
// ============================================================

async function checkActiveSubscription(userId, userRole) {
    // Les coordinateurs et aidants ont toujours accès
    if (userRole === "COORDINATEUR" || userRole === "AIDANT") {
        return true;
    }
    
    try {
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("type_compte, pack_confort_actif, date_fin_pack_confort")
            .eq("id", userId)
            .single();
        
        if (profileErr) return false;
        
        if (profile?.type_compte === 'AVEC_PATIENT') {
            const { data: patient, error: patientErr } = await supabase
                .from("patients")
                .select("statut_paiement, date_fin_abonnement")
                .eq("famille_user_id", userId)
                .single();
            
            if (patientErr || !patient) return false;
            
            if (patient.statut_paiement !== 'A jour') return false;
            
            if (patient.date_fin_abonnement) {
                return new Date() <= new Date(patient.date_fin_abonnement);
            }
            
            return true;
        }
        
        if (profile?.type_compte === 'SANS_PATIENT') {
            if (!profile.pack_confort_actif) return false;
            if (!profile.date_fin_pack_confort) return false;
            return new Date() <= new Date(profile.date_fin_pack_confort);
        }
        
        return false;
        
    } catch (err) {
        console.error("❌ Erreur checkActiveSubscription:", err);
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
