require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoSanitize = require("express-mongo-sanitize");

const supabase = require("./supabaseClient");
const middleware = require("./middleware");
const { createNotification } = require("./routes/notifications");

const app = express();
app.set("trust proxy", 1);

// ============================================================
// CONFIGURATION MULTER
// ============================================================
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// MIDDLEWARES DE SÉCURITÉ
// ============================================================

// 1. Helmet - Sécurise les headers HTTP
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://www.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://*.supabase.co"],
            connectSrc: ["'self'", "https://*.supabase.co", "https://*.onrender.com"],
            fontSrc: ["'self'", "data:"],
        },
    },
}));

// 2. Rate Limiting - Limite les tentatives de connexion
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 tentatives
    message: { error: "Trop de tentatives, réessayez dans 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requêtes par minute
    message: { error: "Trop de requêtes, veuillez ralentir" },
    standardHeaders: true,
    legacyHeaders: false,
});

// 3. Sanitize - Nettoie les entrées contre les injections NoSQL
app.use(mongoSanitize());

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
        'https://app.mysanteplus.com',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'], 
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

app.post('/api/notifications/send', middleware(), async (req, res) => {
    try {
        const { userId, title, message, type, url } = req.body;

        if (!userId || !title || !message) {
            return res.status(400).json({
                error: "userId, title et message sont requis"
            });
        }

        const ok = await createNotification(
            userId,
            title,
            message,
            type || "default",
            url || "/"
        );

        if (!ok) {
            return res.status(500).json({
                error: "Notification non créée"
            });
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

app.post('/api/send-push', middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const { userId, title, body, url } = req.body;

        if (!userId || !title) {
            return res.status(400).json({
                error: "userId et title sont requis"
            });
        }

        const ok = await createNotification(
            userId,
            title,
            body || "Nouvelle notification",
            "push",
            url || "/"
        );

        if (!ok) {
            return res.status(500).json({
                error: "Push non envoyée"
            });
        }

        res.json({ success: true });

    } catch (err) {
        console.error("❌ Erreur send-push:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROUTES AVEC LIMITEURS
// ============================================================

// Routes d'authentification avec limiteur strict
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register-family-patient", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);

// Routes API générales avec limiteur standard
app.use("/api", apiLimiter);

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
const adminSetupRoutes = require("./routes/admin-setup");
const startCronJobs = require("./cron");
const assignmentRoutes = require("./routes/assignments");
const notificationsRoutes = require("./routes/notifications");
const commandesRoutes = require("./routes/commandes");
const planningRoutes = require("./routes/planning");
const educationRoutes = require("./routes/education");
const adminUsersRoutes = require("./routes/admin-users");
 
// ============================================================
// ROUTES
// ============================================================
app.use("/api/auth", authRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/admin-setup", adminSetupRoutes);
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
app.use("/api/admin-users", adminUsersRoutes);

// ============================================================
// DÉMARRAGE
// ============================================================
startCronJobs();


// ============================================================
// ROUTE DE TEST POUR NOTIFICATIONS PUSH
// ============================================================
app.get("/api/test-notification/:userId", async (req, res) => {
  const { userId } = req.params;
  const { sendPushNotification } = require("./utils");
  
  console.log(`📨 Envoi d'une notification test à l'utilisateur: ${userId}`);
  
  try {
    await sendPushNotification(
      userId,
      "🧪 Test notification",
      "Ceci est un test depuis le backend ! 🚀",
      "/#home"
    );
    
    res.json({ 
      success: true, 
      message: `Notification envoyée à l'utilisateur ${userId}` 
    });
  } catch (err) {
    console.error("❌ Erreur envoi test:", err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
