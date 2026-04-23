const admin = require("firebase-admin");

// Initialiser Firebase avec les variables d'environnement
if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || "santeplus-service",
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey
    })
  });
  console.log("✅ Firebase Admin initialisé");
}

const messaging = admin.messaging();

// 🔔 ENVOI NOTIF
async function sendPush(token, title, body) {
    try {
        await messaging.send({
            token,
            notification: {
                title,
                body
            }
        });
        console.log("🔔 Notification envoyée");
    } catch (err) {
        console.error("❌ Erreur push:", err);
    }
}

module.exports = { sendPush };
