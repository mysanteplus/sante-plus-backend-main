const admin = require("firebase-admin");

// 🔥 IMPORTANT : assigner à une variable
const serviceAccount = {
  type: "service_account",
  project_id: "santeplus-service",
  private_key_id: "ea652ba1766795078345da3da45777fa94eb86cb",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDRRfMpZJeIMnJ6\nTkLGVvW6u9HdEo7OtIFa+OHtjuV5wi6wxKyFBfFpWWHyt2X1a4wLtpgbUGTlBDNI\n8QD/bkKrmAM660ph7eNI3tSXH3CYKjC+ncdS48YjajK743njOZ5enk5xL2LxbeI/\n/NF52HXuOTmAFXz+lBVY/VvZv9098pH+ZghNvwNMlgHSdlBVjGa1EB3+8faKZOZx\nKnuyqFaTz954SCcXEH6y+mAa2JzPnsfqub4ra0OqIYW1LvN0+RbYUxAzkg1r+dfL\ni6zy75uCwnIiANrlBtGbZWMafs5UgNlgQ0uvemhpwz8/xp2oS6jVt9bjjZaAeS/0\njwebC1TXAgMBAAECggEAG/R2o4Bi95gZj7n1lI4YPC4LvjbU6crV/sOBVp0AjW/B\nke5rx0dAdNyyR1x1W7/WkNf+4KMwHyGdAjDje7uMX2SqhcvZf1RqSJkvl9Jk1YbJ\nRSVJc4qmtKNijJO5+/7951DJVLhKRMrzbq3Eg7zFICH3yuLT9CPu6BjMFL3a/YO0\nFESVfBcheKhjNS9+i3I2uJrNe0w0QI9u+gt+Jb4gzGW0HeixE2xq1saTPY45R4Ou\n2KMiscy1Ir4mbn5/TtJU9Ce1kjz+Q0NsQafFGInPaGhgjSy2BO9UN5PqZYgHBt2+\nt/MaJA+DY0fJCa24bPuQj32m6iHQ/1/bTIsTqbCpVQKBgQD/w/4rkiADBwvQS7nA\nY/qO5cpzxwXL7AF2hf33ATLQC8JnstCx3Tf/8pCEhnoX4O4zNLpWdx4qgyLAtFIW\nFfI7FlWkBqpkKXuArOHpChQESNKOHACNHkB66v+prVPx6uLgqBo7h6v8O/QcfyRz\npX2qWVKchk6BhtLiCEhJ3YbpuwKBgQDRdwyPncpwOzE2szU5HGbd6XUuSZgM0/Cd\n8kQYsfo12gwiDb58yBvU/tzO1z84bZZEX5318JYtGM3uHRGfjwYL1QlRRjKM1/HJ\nnW1JBnfY9MkpJneEqN1Rh9Hve2VbrWRvbAipA4qnz0OrvPh71surBv8tAcU2MEry\nbWYCc5GxlQKBgQDmzfJfVVVoBgLGLJ/qmw5vx7RjuHVlqYtEbvRY4478KbB8reQg\nrfYsFbQOs+AYDlZGhU2mW4YwbPh+l/r/jTxzz9rm01EOZFTcMKcJCpw3pZPExEZH\nEsazZb/jWdPIGuQ0Qd6yW+N7Eote7+lwJyZ5BHRFZfoQbx989GZvqeZmowKBgQDP\nB5KjtDqtOOQIg5H8U6Uceq22RUkCjMwK4LQLkIWUimJpmhoHbSWNHSYTTk4PMMlP\n5Q3UUqmsAxMu4Q5VHWDFexeNfAtkh99T/cRRZBI6np7gjEOfG+Q7vDl0MQtaVIOr\nWSUqH/UArWveJ5WVmRSOgwjdbB2G1K6O9C/aBm4fDQKBgC1t8hTESdk/SrpLqIk6\nGj05UyiPCrHEOq5qS/1qi34hkqvFV0bI0kQlqIsvTsXVfE55eymIKN6BCeKr8x0w\n0sivzxDUQucEWXPtQde1a2lhDKfMagAAQLKxUfH4DgIUHvKEyBqzYWbK1k8Scs90\njnKwVAUGP828ncSwZCpWfEPx\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-fbsvc@santeplus-service.iam.gserviceaccount.com",
};

// Initialisation Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
