const admin = require("firebase-admin");

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined;

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

    const finalTitle = String(title || "Santé Plus");
    const finalBody = String(body || "Nouvelle notification");
    const finalUrl = String(url || "/");

    console.log(`📨 Envoi push à token: ${token.substring(0, 30)}...`);

    const message = {
      token,

      // ✅ IMPORTANT : data-only pour éviter les notifications doublées
      data: {
        title: finalTitle,
        body: finalBody,
        url: finalUrl,
        type: "push"
      },

      webpush: {
        headers: {
          Urgency: "high",
          TTL: "86400"
        },
        fcmOptions: {
          link: `https://app.mysanteplus.com${finalUrl.startsWith("/") ? finalUrl : "/" + finalUrl}`
        }
      },

      android: {
        priority: "high"
      },

      apns: {
        headers: {
          "apns-priority": "10"
        },
        payload: {
          aps: {
            contentAvailable: true
          }
        }
      }
    };

    const response = await messaging.send(message);

    console.log("✅ Notification envoyée, ID:", response);
    return response;

  } catch (err) {
    console.error("❌ Erreur sendPush:", err.code, err.message);

    if (
      err.code === "messaging/invalid-registration-token" ||
      err.code === "messaging/registration-token-not-registered"
    ) {
      try {
        const supabase = require("./supabaseClient");

        await supabase
          .from("profiles")
          .update({ push_token: null })
          .eq("push_token", token);

        console.log("🗑️ Token invalide supprimé");
      } catch (cleanErr) {
        console.error("❌ Erreur suppression token invalide:", cleanErr.message);
      }
    }

    throw err;
  }
}

module.exports = { sendPush };
