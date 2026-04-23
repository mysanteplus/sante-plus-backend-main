const axios = require("axios");
const webpush = require("web-push");
const supabase = require("./supabaseClient");

// Configuration du moteur Push avec les clés de sécurité VAPID
webpush.setVapidDetails(
  "mailto: info@mysanteplus.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);


/**
 * 🔔 ENVOYER UNE NOTIFICATION PUSH (VIA FIREBASE UNIQUEMENT)
 */
async function sendPushNotification(userId, title, message, url = "/") {
  try {
    // Récupérer le token FCM depuis la base
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("push_token")
      .eq("id", userId)
      .single();

    if (error || !profile?.push_token) {
      console.log(`📭 Pas de token FCM pour l'utilisateur ${userId}`);
      return;
    }

    // Envoyer via Firebase (le backend s'en chargera via firebaseAdmin.js)
    // On appelle notre API backend qui utilise firebase-admin
    await axios.post(`${process.env.API_URL}/send-push`, {
      token: profile.push_token,
      title: title,
      body: message,
      url: url
    });

    console.log(`✅ Notification FCM envoyée à ${userId}`);

  } catch (err) {
    console.error("❌ Erreur sendPushNotification:", err.message);
  }
}

/**
 * 📧 ENVOYER UN EMAIL VIA BREVO API
 */
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
// 📅 FONCTIONS DE GESTION DES ABONNEMENTS (AJOUTÉES)
// ============================================================

/**
 * 📅 CALCULER LA DATE DE FIN D'ABONNEMENT (selon la durée)
 * @param {Date} startDate - Date de début
 * @param {number} durationMonths - Durée en mois (1, 3, 6, 12)
 * @param {number} graceDays - Jours de grâce (5 par défaut)
 * @returns {Date} Date de fin
 */
function calculateSubscriptionEndDate(startDate, durationMonths, graceDays = 5) {
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + durationMonths);
  endDate.setDate(endDate.getDate() + graceDays);
  return endDate;
}

/**
 * 📊 CALCULER LES JOURS RESTANTS
 * @param {Date|string} endDate - Date de fin
 * @returns {number} Nombre de jours restants
 */
function getDaysRemaining(endDate) {
  if (!endDate) return 0;
  const today = new Date();
  const diffTime = new Date(endDate) - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays > 0 ? diffDays : 0;
}

/**
 * 🔒 VÉRIFIER SI L'ABONNEMENT EST VALIDE
 * @param {Date|string} endDate - Date de fin
 * @returns {boolean} true si valide
 */
function isSubscriptionValid(endDate) {
  if (!endDate) return false;
  const today = new Date();
  return today <= new Date(endDate);
}

/**
 * 📦 Récupérer la durée en mois selon l'ID du pack
 * @param {string} packId - ID du pack (ex: MENSUEL, TRIMESTRIEL, ANNUEL)
 * @returns {number} Durée en mois
 */
function getDurationFromPack(packId) {
  if (!packId) return 1;
  if (packId.includes('TRIMESTRIEL') || packId.includes('trimestriel')) return 3;
  if (packId.includes('SEMESTRIEL') || packId.includes('semestriel')) return 6;
  if (packId.includes('ANNUEL') || packId.includes('annuel')) return 12;
  return 1; // MENSUEL par défaut
}

/**
 * 💰 Calculer le prix avec réduction selon la durée
 * @param {number} basePrice - Prix mensuel de base
 * @param {number} durationMonths - Durée en mois
 * @returns {number} Prix total avec réduction
 */
function calculateDiscountedPrice(basePrice, durationMonths) {
  if (durationMonths === 3) {
    return Math.round(basePrice * durationMonths * 0.95); // -5%
  }
  if (durationMonths === 6) {
    return Math.round(basePrice * durationMonths * 0.90); // -10%
  }
  if (durationMonths === 12) {
    return Math.round(basePrice * durationMonths * 0.85); // -15%
  }
  return basePrice * durationMonths;
}


// ============================================================
// 📡 REALTIME CHANNEL GLOBAL (BACKEND)
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
  calculateDiscountedPrice
};
