// backend/firebaseAdmin.js
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined;

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    console.error("❌ Variables Firebase Admin manquantes");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });

  console.log("✅ Firebase Admin initialisé:", process.env.FIREBASE_PROJECT_ID);
}

const messaging = admin.messaging();

async function sendPush(token, title, body, url = "/") {
  try {
    if (!token || token.length < 50) {
      console.error("❌ Token FCM invalide:", token);
      return null;
    }

    const finalUrl = url || "/";

    console.log(`📨 Envoi push à token: ${token.substring(0, 30)}...`);

    const message = {
      token,

      // Important pour que le service worker puisse lire les données
      data: {
        title: String(title || "Santé Plus"),
        body: String(body || "Nouvelle notification"),
        url: String(finalUrl)
      },

      // Notification système standard
      notification: {
        title: String(title || "Santé Plus"),
        body: String(body || "Nouvelle notification")
      },

      webpush: {
        headers: {
          Urgency: "high",
          TTL: "86400"
        },
        notification: {
          title: String(title || "Santé Plus"),
          body: String(body || "Nouvelle notification"),
          icon: "https://app.mysanteplus.com/assets/images/logo-general-icon.png",
          badge: "https://app.mysanteplus.com/assets/images/logo-general-icon.png",
          requireInteraction: true,
          renotify: true,
          tag: `sante-plus-${Date.now()}`,
          vibrate: [200, 100, 200],
          actions: [
            { action: "open", title: "Ouvrir" }
          ],
          data: {
            url: finalUrl
          }
        },
        fcmOptions: {
          link: `https://app.mysanteplus.com${finalUrl.startsWith("/") ? finalUrl : "/" + finalUrl}`
        }
      },

      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "sante_plus_channel",
          priority: "max",
          visibility: "public"
        }
      },

      apns: {
        headers: {
          "apns-priority": "10"
        },
        payload: {
          aps: {
            alert: {
              title: String(title || "Santé Plus"),
              body: String(body || "Nouvelle notification")
            },
            sound: "default",
            badge: 1
          }
        }
      }
    };

    const response = await messaging.send(message);
    console.log("✅ Notification envoyée, ID:", response);
    return response;

  } catch (err) {
    console.error("❌ Erreur sendPush:", err.code, err.message);

    const invalidCodes = [
      "messaging/invalid-registration-token",
      "messaging/registration-token-not-registered"
    ];

    if (invalidCodes.includes(err.code)) {
      try {
        const supabase = require("./supabaseClient");
        await supabase
          .from("profiles")
          .update({ push_token: null })
          .eq("push_token", token);

        console.log("🗑️ Token invalide supprimé de la base");
      } catch (cleanErr) {
        console.error("❌ Erreur suppression token invalide:", cleanErr.message);
      }
    }

    throw err;
  }
}

module.exports = { sendPush };
