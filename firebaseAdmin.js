const admin = require("firebase-admin");

if (!admin.apps.length) {
  // Utilisation des variables d'environnement Render
  const privateKey = process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || "santeplus-service-9ad08",
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "firebase-adminsdk-fbsvc@santeplus-service-9ad08.iam.gserviceaccount.com",
      privateKey: privateKey
    })
  });
  console.log("✅ Firebase Admin initialisé");
}

const messaging = admin.messaging();

async function sendPush(token, title, body) {
    try {
        // Vérifier que le token est valide
        if (!token || token.length < 50) {
            console.error("❌ Token FCM invalide:", token);
            return null;
        }
        
        console.log(`📨 Envoi push à token: ${token.substring(0, 30)}...`);
        
        const message = {
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
                    channelId: "sante_plus_channel",
                    clickAction: "FLUTTER_NOTIFICATION_CLICK"
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: "default",
                        badge: 1
                    }
                }
            },
            webpush: {
                headers: {
                    Urgency: "high"
                },
                notification: {
                    requireInteraction: true,
                    vibrate: [200, 100, 200],
                    icon: "https://app.mysanteplus.com/assets/images/logo-general-icon.png",
                    badge: "https://app.mysanteplus.com/assets/images/logo-general-icon.png"
                }
            }
        };
        
        const response = await messaging.send(message);
        console.log("✅ Notification envoyée, ID:", response);
        return response;
        
    } catch (err) {
        console.error("❌ Erreur sendPush:", err.message);
        if (err.code === "messaging/invalid-registration-token") {
            // Token invalide, on le supprime de la base
            const { supabase } = require("./supabaseClient");
            await supabase
                .from("profiles")
                .update({ push_token: null })
                .eq("push_token", token);
            console.log("🗑️ Token invalide supprimé de la base");
        }
        throw err;
    }
}

module.exports = { sendPush };
