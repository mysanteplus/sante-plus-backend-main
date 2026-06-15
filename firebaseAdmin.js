const admin = require("firebase-admin");

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey
    })
  });
  console.log("✅ Firebase Admin initialisé");
}

const messaging = admin.messaging();

async function sendPush(token, title, body) {
    try {
        const response = await messaging.send({
            token: token,
            notification: { 
                title: title, 
                body: body,
                sound: "default"
            },
            android: {
                priority: "high",
                notification: {
                    sound: "default",
                    channelId: "sante_plus_channel"
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: "default",
                        badge: 1
                    }
                }
            }
        });
        console.log("🔔 Notification envoyée, ID:", response);
        return response;
    } catch (err) {
        console.error("❌ Erreur sendPush:", err.message);
        throw err;
    }
}

module.exports = { sendPush };
