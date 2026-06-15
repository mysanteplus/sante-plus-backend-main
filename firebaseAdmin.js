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

    const message = {
      token,

      notification: {
        title: title || "Santé Plus",
        body: body || "Nouvelle notification"
      },

      data: {
        title: String(title || "Santé Plus"),
        body: String(body || "Nouvelle notification"),
        url: String(url || "/")
      },

      webpush: {
        headers: {
          Urgency: "high",
          TTL: "86400"
        },
        notification: {
          title: title || "Santé Plus",
          body: body || "Nouvelle notification",
          icon: "https://app.mysanteplus.com/assets/images/logo-general-icon.png",
          badge: "https://app.mysanteplus.com/assets/images/logo-general-icon.png",
          requireInteraction: true,
          renotify: true,
          tag: `sante-plus-${Date.now()}`,
          vibrate: [200, 100, 200],
          data: {
            url: url || "/"
          }
        },
        fcmOptions: {
          link: `https://app.mysanteplus.com${url || "/"}`
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
      const supabase = require("./supabaseClient");

      await supabase
        .from("profiles")
        .update({ push_token: null })
        .eq("push_token", token);

      console.log("🗑️ Token invalide supprimé");
    }

    throw err;
  }
}

module.exports = { sendPush };
