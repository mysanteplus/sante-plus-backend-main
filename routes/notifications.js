// routes/notifications.js - VERSION BACKEND PUR (CORRIGÉE)

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

// ============================================================
// 📋 RÉCUPÉRER LES NOTIFICATIONS DE L'UTILISATEUR
// ============================================================

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

// ============================================================
// ✅ MARQUER UNE NOTIFICATION COMME LUE
// ============================================================

router.post("/mark-read/:id", middleware(), async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("notifications")
      .update({
        read: true,
        read_at: new Date().toISOString()
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

// ============================================================
// ✅ MARQUER TOUTES LES NOTIFICATIONS COMME LUES
// ============================================================

router.post("/mark-all-read", middleware(), async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({
        read: true,
        read_at: new Date().toISOString()
      })
      .eq("user_id", req.user.userId)
      .eq("read", false);

    if (error) throw error;

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur mark-all-read:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔔 CRÉER UNE NOTIFICATION COMPLÈTE AVEC REDIRECTION
// ============================================================

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

    // ✅ URL PAR DÉFAUT SELON LE TYPE
    let finalUrl = url;
    
    if (!url || url === "/" || url === "/#") {
      switch (type) {
        case "visit":
          finalUrl = "/#visits";
          break;
        case "payment":
          finalUrl = "/#billing";
          break;
        case "assignment":
          finalUrl = "/#planning";
          break;
        case "expiration":
          finalUrl = "/#subscription";
          break;
        case "message":
          finalUrl = "/#feed";
          break;
        case "commande":
          finalUrl = "/#commandes";
          break;
        case "notification":
          finalUrl = "/#notifications";
          break;
        default:
          // Garder l'URL par défaut
          break;
      }
    }

    const finalTitle = title || "Santé Plus";
    const finalMessage = message || "Nouvelle notification";
    const finalType = type || "default";

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
          read_at: null,
          created_at: new Date().toISOString()
        }
      ]);

    if (error) {
      console.error("❌ Erreur insertion notification:", error);
      throw error;
    }

    console.log(`✅ Notification enregistrée pour ${userId}: ${finalTitle} → ${finalUrl}`);

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
      console.error("⚠️ Erreur push dans createNotification:", pushErr.message);
    }

    return true;
  } catch (err) {
    console.error("❌ Erreur création notification:", err.message);
    return false;
  }
}

// ============================================================
// 🗑️ SUPPRIMER UNE NOTIFICATION
// ============================================================

router.delete("/:id", middleware(), async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("id", id)
      .eq("user_id", req.user.userId);

    if (error) throw error;

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur suppression notification:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 📊 COMPTER LES NOTIFICATIONS NON LUES
// ============================================================

router.get("/unread-count", middleware(), async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", req.user.userId)
      .eq("read", false);

    if (error) throw error;

    res.json({ unread: count || 0 });
  } catch (err) {
    console.error("❌ Erreur comptage notifications:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EXPORTS
// ============================================================

module.exports = router;
module.exports.createNotification = createNotification;
