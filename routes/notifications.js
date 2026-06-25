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
    console.error("❌ Erreur récupération notifications:", err.message);
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
      .update({
        read: true,
        read_at: new Date()
      })
      .eq("id", id)
      .eq("user_id", req.user.userId);

    if (error) throw error;

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur mark-read:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ MARQUER TOUTES LES NOTIFICATIONS COMME LUES
 */
 
router.post("/mark-all-read", middleware(), async (req, res) => {
  try {
    // Vérifier si la colonne read_at existe
    const { data: columns } = await supabase
      .from('notifications')
      .select('read_at')
      .limit(1);
    
    const hasReadAt = columns !== null;
    
    const updateData = {
      read: true
    };
    
    if (hasReadAt) {
      updateData.read_at = new Date().toISOString();
    }
    
    const { error } = await supabase
      .from("notifications")
      .update(updateData)
      .eq("user_id", req.user.userId)
      .eq("read", false);

    if (error) throw error;

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur mark-all-read:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔔 CRÉER UNE NOTIFICATION COMPLÈTE
 *
 * Cette fonction :
 * 1. Enregistre la notification dans Supabase
 * 2. Envoie une push Firebase si l'utilisateur a un push_token
 *
 * Important :
 * sendPushNotification() ne doit PAS réinsérer dans Supabase.
 */
async function createNotification(
  userId,
  title,
  message,
  type = "default",
  url = "/"
) {
  try {
    if (!userId) {
      console.warn("⚠️ createNotification ignorée : userId manquant");
      return false;
    }

    const finalTitle = title || "Santé Plus";
    const finalMessage = message || "Nouvelle notification";
    const finalType = type || "default";
    const finalUrl = url || "/";

    // 1. Enregistrer dans la table notifications
    const { error } = await supabase
      .from("notifications")
      .insert([
        {
          user_id: userId,
          title: finalTitle,
          message: finalMessage,
          type: finalType,
          url: finalUrl,
          read: false,
          created_at: new Date()
        }
      ]);

    if (error) throw error;

    console.log(`✅ Notification enregistrée pour ${userId}`);

    // 2. Envoyer la push système
    try {
      const { sendPushNotification } = require("../utils");

      const pushOk = await sendPushNotification(
        userId,
        finalTitle,
        finalMessage,
        finalUrl
      );

      if (pushOk) {
        console.log(`✅ Push envoyée pour ${userId}`);
      } else {
        console.log(`📭 Notification enregistrée, mais push non envoyée pour ${userId}`);
      }
    } catch (pushErr) {
      // Important : on ne bloque pas l'app si la push échoue.
      // La notification interne existe déjà.
      console.error("⚠️ Erreur push dans createNotification:", pushErr.message);
    }

    return true;
  } catch (err) {
    console.error("❌ Erreur création notification:", err.message);
    return false;
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
