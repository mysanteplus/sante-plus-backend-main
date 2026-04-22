// backend/routes/notifications.js
const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

/**
 * 📋 RÉCUPÉRER LES NOTIFICATIONS DE L'UTILISATEUR
 */
router.get("/", middleware(), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("notifications")
            .select("*")
            .eq("user_id", req.user.userId)
            .order("created_at", { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * ✅ MARQUER UNE NOTIFICATION COMME LUE
 */
router.post("/mark-read/:id", middleware(), async (req, res) => {
    const { id } = req.params;
    
    try {
        const { error } = await supabase
            .from("notifications")
            .update({ read: true })
            .eq("id", id)
            .eq("user_id", req.user.userId);

        if (error) throw error;
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 ✅ MARQUER TOUTES LES NOTIFICATIONS COMME LUES
 */
router.post("/mark-all-read", middleware(), async (req, res) => {
    try {
        const { error } = await supabase
            .from("notifications")
            .update({ read: true })
            .eq("user_id", req.user.userId)
            .eq("read", false);

        if (error) throw error;
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 🔔 CRÉER UNE NOTIFICATION (appelé par d'autres modules)
 * @param {string} userId - ID de l'utilisateur
 * @param {string} title - Titre de la notification
 * @param {string} message - Message
 * @param {string} type - Type (visit, payment, assignment, alert, message, expiration)
 * @param {string} url - URL de redirection
 */
async function createNotification(userId, title, message, type = 'default', url = null) {
    try {
        // ✅ Si l'URL est vide ou null, mettre une valeur par défaut
        const finalUrl = url || '/home';
        
        const { error } = await supabase
            .from("notifications")
            .insert([{
                user_id: userId,
                title,
                message,
                type,
                url: finalUrl,
                read: false,
                created_at: new Date()
            }]);
            
        if (error) throw error;
        
        // Envoyer aussi une notification push
        const { sendPushNotification } = require("../utils");
        await sendPushNotification(userId, title, message, finalUrl);
        
        return true;
    } catch (err) {
        console.error("Erreur création notification:", err);
        return false;
    }
}

module.exports = router;
module.exports.createNotification = createNotification;
