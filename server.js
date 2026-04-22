require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const supabase = require("./supabaseClient");
const middleware = require("./middleware");

const app = express();

// ============================================================
// CONFIGURATION MULTER
// ============================================================
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// MIDDLEWARES GLOBAUX
// ============================================================

// Servir les fichiers statiques
app.use('/assets', express.static('assets'));

// Limites augmentées
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Timeout global
app.use((req, res, next) => {
    req.setTimeout(60000);
    res.setTimeout(60000);
    next();
});

// ============================================================
// CORS (CORRIGÉ)
// ============================================================
app.use(cors({
    origin: [
        'https://stevenckohr-pixel.github.io',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'], // ← AJOUTÉ Cache-Control
    credentials: true
}));

// ============================================================
// ROUTES PUBLIQUES (SANS AUTHENTIFICATION)
// ============================================================

// Health check
app.get("/", (req, res) => res.send("🚀 Santé Plus Services API opérationnelle"));

// ============================================================
// ROUTES DE NOTIFICATIONS
// ============================================================

// Route pour les notifications (utilisée par visites.js)
app.post('/api/notifications/send', middleware(), async (req, res) => {
    try {
        const { userId, title, message, type, url } = req.body;
        
        const { error } = await supabase.from("notifications").insert([{
            user_id: userId,
            title: title,
            message: message,
            type: type || "visit",
            url: url || "/",
            read: false,
            created_at: new Date()
        }]);
        
        if (error) throw error;
        
        const { sendPush } = require("./firebaseAdmin");
        const { data: profile } = await supabase
            .from("profiles")
            .select("push_token")
            .eq("id", userId)
            .single();
        
        if (profile?.push_token) {
            await sendPush(profile.push_token, title, message);
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Erreur send notification:", err);
        res.status(500).json({ error: err.message });
    }
});

// Route pour sauvegarder le token push
app.post('/api/save-push-token', async (req, res) => {
    try {
        const { token, user_id } = req.body;

        if (!token) {
            return res.status(400).json({ error: "Token manquant" });
        }

        await supabase
            .from('profiles')
            .update({ push_token: token })
            .eq('id', user_id);

        console.log("🔥 Token sauvegardé:", user_id);

        res.json({ success: true });

    } catch (err) {
        console.error("❌ Erreur save token:", err);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Route push unifiée (Firebase Admin)
app.post('/api/send-push', async (req, res) => {
    try {
        const { token, title, body, url } = req.body;
        
        if (!token || !title) {
            return res.status(400).json({ error: "Token et titre requis" });
        }

        const { sendPush } = require("./firebaseAdmin");
        
        await sendPush(token, title, body);
        
        const { data: user } = await supabase
            .from("profiles")
            .select("id")
            .eq("push_token", token)
            .single();
        
        if (user) {
            await supabase.from("notifications").insert([{
                user_id: user.id,
                title: title,
                message: body,
                type: "push",
                url: url || "/",
                read: false,
                created_at: new Date()
            }]);
        }
        
        res.json({ success: true });
        
    } catch (err) {
        console.error("❌ Erreur send-push:", err);
        res.status(500).json({ error: err.message });
    }
});


app.get("/api/kikiapay/confirm", (req, res) => {
    // Rediriger vers la fonction de confirmation
    require("./routes/kikiapay").handleConfirm(req, res);
});
// ============================================================
// IMPORTS DES ROUTES
// ============================================================
const authRoutes = require("./routes/auth");
const billingRoutes = require("./routes/billing");
const patientRoutes = require("./routes/patients");
const visitesRoutes = require("./routes/visites");
const messagesRoutes = require("./routes/messages");
const dashboardRoutes = require("./routes/dashboard");
const aidantRoutes = require("./routes/aidants");
const adminRoutes = require("./routes/admin");
const startCronJobs = require("./cron");
const assignmentRoutes = require("./routes/assignments");
const notificationsRoutes = require("./routes/notifications");
const commandesRoutes = require("./routes/commandes");
const planningRoutes = require("./routes/planning");
const educationRoutes = require("./routes/education");

// ... (tout le début inchangé)

// ============================================================
// ROUTES
// ============================================================
app.use("/api/auth", authRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/aidants", aidantRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/visites", visitesRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/commandes", commandesRoutes);
app.use("/api/planning", planningRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/educational", educationRoutes);
app.use("/api/kikiapay", require("./routes/kikiapay"));

// ============================================================
// DÉMARRAGE
// ============================================================
startCronJobs();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
