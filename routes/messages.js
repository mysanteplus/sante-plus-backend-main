//VERSION COMPLÈTE AVEC LA ROUTE PHOTO ET VÉRIFICATION ABONNEMENT

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { checkActiveSubscription } = require("../utils");  
const { createNotification } = require("./notifications");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// 📥 1. LIRE LE FIL D'ACTUALITÉ (avec vérification abonnement)
// ============================================================
router.get(
  "/",
  middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
  async (req, res) => {
    const { patient_id, message_id } = req.query;
    const currentUserId = req.user.userId;
    const currentRole = req.user.role;

    try {
      // ✅ VÉRIFICATION ABONNEMENT ACTIF (pour les comptes FAMILLE)
      if (currentRole === "FAMILLE") {
        const hasSubscription = await checkActiveSubscription(currentUserId, currentRole);
        if (!hasSubscription) {
          console.log(`❌ Accès aux messages refusé: abonnement inactif pour ${currentUserId}`);
          return res.json([]);
        }
        console.log(`✅ Abonnement actif pour ${currentUserId}`);
      }

      // 🔥 CAS 1 : Récupération d'un seul message (pour Realtime)
      if (message_id) {
        const { data, error } = await supabase
          .from("messages")
          .select(`
            *,
            sender:profiles!messages_sender_id_fkey (
              id,
              nom, 
              role, 
              photo_url
            )
          `)
          .eq("id", message_id)
          .single();

        if (error) throw error;


        const canAccessPatient = await hasAccessToPatient(data.patient_id, currentUserId, currentRole);

        if (!canAccessPatient) {
          return res.status(403).json({ error: "Accès non autorisé à ce dossier patient" });
        }
        
        if (!hasAccessToMessage(data, currentUserId, currentRole)) {
          return res.status(403).json({ error: "Accès non autorisé à ce message" });
        }
        

        // Formatage du message unique avec sender_id
        return res.json([{
          id: data.id,
          patient_id: data.patient_id,
          content: data.content,
          is_photo: data.is_photo,
          photo_url: data.photo_url || null,
          reply_to_id: data.reply_to_id || null,
          reactions: data.reactions || {},
          created_at: data.created_at,
          sender_id: data.sender?.id || null,
          sender_name: data.sender?.nom || "Membre",
          sender_role: data.sender?.role || "MEMBRE",
          sender_photo: data.sender?.photo_url || null,
          read: data.read || false,
          read_at: data.read_at || null,
          type_media: data.type_media || "STORY",
          titre_media: data.titre_media || null,
          visibility: data.visibility || "all"
        }]);
      }

      // 🔥 CAS 2 : Récupération de tous les messages d'un patient
      if (!patient_id) {
        return res.status(400).json({ error: "ID du patient manquant" });
      }

      const canAccessPatient = await hasAccessToPatient(patient_id, currentUserId, currentRole);

        if (!canAccessPatient) {
          return res.status(403).json({ error: "Accès non autorisé à ce dossier patient" });
        }

      const { data, error } = await supabase
        .from("messages")
        .select(`
          *,
          sender:profiles!messages_sender_id_fkey (
            id,
            nom, 
            role, 
            photo_url
          )
        `)
        .eq("patient_id", patient_id)
        .order("created_at", { ascending: true });

      if (error) throw error;

      // Filtrer les messages selon les droits d'accès
      const filteredMessages = data.filter(msg => 
        hasAccessToMessage(msg, currentUserId, currentRole)
      );

      // Formatage des messages avec sender_id
      const cleanedMessages = filteredMessages.map((m) => ({
        id: m.id,
        content: m.content,
        patient_id: m.patient_id,
        is_photo: m.is_photo,
        photo_url: m.photo_url || null,
        reply_to_id: m.reply_to_id || null,
        reactions: m.reactions || {},
        created_at: m.created_at,
        sender_id: m.sender?.id || null,
        sender_name: m.sender?.nom || "Système",
        sender_role: m.sender?.role || "COORDINATEUR",
        sender_photo: m.sender?.photo_url || null,
        read: m.read || false,
        read_at: m.read_at || null,
        type_media: m.type_media || "STORY",
        titre_media: m.titre_media || null,
        visibility: m.visibility || "all"
      }));

      res.json(cleanedMessages);

    } catch (err) {
      console.error("❌ Erreur GET /messages:", err);
      res.status(500).json({ error: err.message });
    }
  }
);



async function hasAccessToPatient(patientId, userId, role) {
  if (!patientId || !userId || !role) return false;

  if (role === "COORDINATEUR") {
    return true;
  }

  if (role === "FAMILLE") {
    const { data: patient, error } = await supabase
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .eq("famille_user_id", userId)
      .maybeSingle();

    return !error && !!patient;
  }

  if (role === "AIDANT") {
    const { data: planning, error } = await supabase
      .from("planning")
      .select("id")
      .eq("patient_id", patientId)
      .eq("aidant_id", userId)
      .eq("est_actif", true)
      .maybeSingle();

    return !error && !!planning;
  }

  return false;
}

// ============================================================
// FONCTION DE VÉRIFICATION D'ACCÈS
// ============================================================

function hasAccessToMessage(message, userId, role) {
  const visibility = message.visibility || 'all';
  
  // L'expéditeur peut toujours voir son message
  if (message.sender_id === userId) return true;
  
  // Messages publics
  if (visibility === 'all') return true;
  
  // Messages pour la famille uniquement
  if (visibility === 'family') {
    return role === 'FAMILLE';
  }
  
  // Messages pour les aidants uniquement
  if (visibility === 'aidant') {
    return role === 'AIDANT';
  }
  
  // Messages pour le coordinateur uniquement
  if (visibility === 'coordinateur') {
    return role === 'COORDINATEUR';
  }
  
  return false;
}

// ============================================================
// 🔔 NOTIFIER LES DESTINATAIRES D'UN MESSAGE
// ============================================================
async function notifyMessageRecipients({
  patient_id,
  sender_id,
  title,
  message,
  url = "/#feed"
}) {
  try {
    const { data: patient, error } = await supabase
      .from("patients")
      .select("famille_user_id, coordonnateur_id, nom_complet")
      .eq("id", patient_id)
      .single();

    if (error || !patient) {
      console.warn("⚠️ Patient introuvable pour notification message:", error?.message);
      return;
    }

    const targetIds = [
      patient.famille_user_id,
      patient.coordonnateur_id
    ].filter(id => id && id !== sender_id);

    if (targetIds.length === 0) {
      console.log("📭 Aucun destinataire à notifier pour ce message");
      return;
    }

    for (const targetId of targetIds) {
      await createNotification(
        targetId,
        title,
        message,
        "message",
        url
      );
    }

    console.log(`✅ ${targetIds.length} notification(s) message envoyée(s)`);
  } catch (err) {
    console.error("❌ Erreur notifyMessageRecipients:", err.message);
  }
}

// ============================================================
// ❤️ 2. AJOUTER UNE RÉACTION
// ============================================================
router.post(
  "/react",
  middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
  async (req, res) => {
    const { message_id, reaction_type } = req.body;

    if (!message_id) {
      return res.status(400).json({ error: "message_id requis" });
    }

    if (!reaction_type) {
      return res.status(400).json({ error: "reaction_type requis" });
    }

    const currentUserId = req.user.userId;
    const currentRole = req.user.role;

    try {
      // 1. Récupérer le message complet pour connaître son patient_id, sender_id, visibility
      const { data: msg, error: fetchErr } = await supabase
        .from("messages")
        .select("id, patient_id, sender_id, visibility, reactions")
        .eq("id", message_id)
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      if (!msg) {
        return res.status(404).json({ error: "Message introuvable" });
      }

      // 2. Vérifier que l'utilisateur a accès au dossier patient
      const canAccessPatient = await hasAccessToPatient(
        msg.patient_id,
        currentUserId,
        currentRole
      );

      if (!canAccessPatient) {
        return res.status(403).json({
          error: "Accès non autorisé à ce dossier patient"
        });
      }

      // 3. Vérifier que l'utilisateur a le droit de voir ce message selon visibility
      const canAccessMessage = hasAccessToMessage(
        msg,
        currentUserId,
        currentRole
      );

      if (!canAccessMessage) {
        return res.status(403).json({
          error: "Accès non autorisé à ce message"
        });
      }

      // 4. Ajouter la réaction
      const reactions = msg.reactions || {};

      reactions[reaction_type] = (reactions[reaction_type] || 0) + 1;

      const { error: updateErr } = await supabase
        .from("messages")
        .update({ reactions })
        .eq("id", message_id);

      if (updateErr) throw updateErr;

      res.json({
        status: "success",
        reactions
      });

    } catch (err) {
      console.error("❌ Erreur /messages/react:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// ✉️ 3. ENVOYER UN MESSAGE TEXTE
// ============================================================

router.post(
    "/send",
    middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
    async (req, res) => {
        const { patient_id, content, is_photo, type_media, titre_media, reply_to_id, visibility } = req.body;

        if (!content) {
            return res.status(400).json({ error: "Le contenu est vide" });
        }

        // 🔥 CORRECTION sender_id SAFE
        const sender_id = req.user?.userId || req.body.sender_id;

        if (!sender_id) {
            return res.status(400).json({ error: "sender_id manquant" });
        }

        if (req.user.role === "FAMILLE") {
            const { data: patient, error } = await supabase
                .from("patients")
                .select("id")
                .eq("id", patient_id)
                .eq("famille_user_id", req.user.userId)
                .single();

            if (error || !patient) {
                return res.status(403).json({ error: "Vous ne pouvez pas écrire sur ce dossier" });
            }
        }

        if (req.user.role === "AIDANT") {
            const { data: planning, error } = await supabase
                .from("planning")
                .select("id")
                .eq("patient_id", patient_id)
                .eq("aidant_id", req.user.userId)
                .maybeSingle();

            if (error || !planning) {
                return res.status(403).json({ error: "Vous n'êtes pas autorisé à envoyer un message à ce patient" });
            }
        }

        try {
            const messageData = {
                patient_id,
                sender_id,
                content,
                is_photo: is_photo || false,
                reactions: {},
                visibility: visibility || 'all', 
            };

            if (type_media) messageData.type_media = type_media;
            if (titre_media) messageData.titre_media = titre_media;
            if (reply_to_id) messageData.reply_to_id = reply_to_id;

            const { data: insertedMessage, error } = await supabase
                .from("messages")
                .insert([messageData])
                .select()
                .single();

            if (error) throw error;

// 🔔 Notification interne + push système
let notificationTitle = "💬 Nouveau message";
let notificationBody = content || "Un nouveau message a été envoyé.";

if (is_photo) {
    notificationTitle = "📸 Nouvelle photo";
    notificationBody = "Une nouvelle photo a été ajoutée au journal.";
}

if (type_media === "DOCUMENT") {
    notificationTitle = "📄 Nouveau document";
    notificationBody = "Un nouveau document a été ajouté au dossier.";
}

await notifyMessageRecipients({
    patient_id,
    sender_id,
    title: notificationTitle,
    message: notificationBody,
    url: "/#feed"
});

            res.json({ status: "success" });

        } catch (err) {
            console.error("❌ Erreur envoi message:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

// ============================================================
// 📸 4. ENVOYER UNE PHOTO
// ============================================================
router.post(
    "/send-photo",
    middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
    upload.single("photo"),
    async (req, res) => {
        console.log("🔵 [send-photo] Route appelée");
        
        const { patient_id, reply_to_id, caption, visibility } = req.body;
        const photoFile = req.file;

        if (!photoFile) {
            return res.status(400).json({ error: "Photo requise" });
        }
        if (!patient_id) {
            return res.status(400).json({ error: "ID patient requis" });
        }

        try {
            // Vérifications de sécurité
            if (req.user.role === "FAMILLE") {
                const { data: patient, error } = await supabase
                    .from("patients")
                    .select("id")
                    .eq("id", patient_id)
                    .eq("famille_user_id", req.user.userId)
                    .single();

                if (error || !patient) {
                    return res.status(403).json({ error: "Action non autorisée" });
                }
            }

            if (req.user.role === "AIDANT") {
                const { data: planning, error } = await supabase
                    .from("planning")
                    .select("id")
                    .eq("patient_id", patient_id)
                    .eq("aidant_id", req.user.userId)
                    .maybeSingle();

                if (error || !planning) {
                    return res.status(403).json({ error: "Vous n'êtes pas assigné à ce patient" });
                }
            }

            // Upload vers Supabase Storage
            const fileExtension = photoFile.originalname?.split('.').pop() || 'jpg';
            const fileName = `messages/${patient_id}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExtension}`;
            
            const { error: uploadError } = await supabase.storage
                .from("preuves")
                .upload(fileName, photoFile.buffer, {
                    contentType: photoFile.mimetype || "image/jpeg",
                    upsert: false,
                });

            if (uploadError) {
                console.error("❌ Erreur upload:", uploadError);
                throw uploadError;
            }

            const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
            const photoUrl = urlData.publicUrl;

            // Création du message
            const messageData = {
                patient_id: patient_id,
                sender_id: req.user.userId,
                content: photoUrl,
                photo_url: photoUrl,
                is_photo: true,
                type_media: 'STORY',
                reply_to_id: reply_to_id || null,
                reactions: {},
                read: false,
                created_at: new Date().toISOString(),
                visibility: visibility || 'all',
            };

            const { data: newMessage, error: insertError } = await supabase
                .from("messages")
                .insert([messageData])
                .select()
                .single();

            if (insertError) {
                console.error("❌ Erreur insertion message:", insertError);
                throw insertError;
            }

            console.log("✅ Photo envoyée, message créé:", newMessage.id);

          // Notification interne + push système
          await notifyMessageRecipients({
              patient_id,
              sender_id: req.user.userId,
              title: "📸 Nouvelle photo",
              message: "Une nouvelle photo a été ajoutée au journal.",
              url: "/#feed"
          });

            res.json({ 
                status: "success", 
                photo_url: photoUrl,
                message_id: newMessage.id
            });

        } catch (err) {
            console.error("❌ Erreur send-photo:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

// ============================================================
// 👁️ MARQUER LES MESSAGES COMME LUS
// ============================================================
router.post('/mark-read', middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        const { patient_id } = req.body;

        if (!patient_id) {
            return res.status(400).json({ error: "patient_id requis" });
        }

        const userId = req.user.userId;

      const canAccessPatient = await hasAccessToPatient(patient_id, userId, req.user.role);

        if (!canAccessPatient) {
          return res.status(403).json({ error: "Accès non autorisé à ce dossier patient" });
        }

        if (!userId) {
            return res.status(401).json({ error: "Utilisateur non identifié" });
        }

        const { error } = await supabase
            .from('messages')
            .update({
                read: true,
                read_at: new Date().toISOString()
            })
            .eq('patient_id', patient_id)
            .eq('read', false)
            .neq('sender_id', userId);

        if (error) throw error;

        console.log("👁️ Messages marqués comme lus:", patient_id);

        res.json({ success: true });

    } catch (err) {
        console.error("❌ mark-read error:", err);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// ============================================================
// 📎 5. ENVOYER UN DOCUMENT (PDF, DOC, etc.)
// ============================================================
router.post(
    "/send-document",
    middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
    upload.single("document"),
    async (req, res) => {
        console.log("🔵 [send-document] Route appelée");
        
        const { patient_id, reply_to_id, type_media, visibility } = req.body;
        const documentFile = req.file;

        if (!documentFile) {
            return res.status(400).json({ error: "Document requis" });
        }

        if (!patient_id) {
            return res.status(400).json({ error: "ID patient requis" });
        }

        try {
            // Vérifications de sécurité
            if (req.user.role === "FAMILLE") {
                const { data: patient, error } = await supabase
                    .from("patients")
                    .select("id")
                    .eq("id", patient_id)
                    .eq("famille_user_id", req.user.userId)
                    .single();

                if (error || !patient) {
                    return res.status(403).json({ error: "Action non autorisée" });
                }
            }

            if (req.user.role === "AIDANT") {
                const { data: planning, error } = await supabase
                    .from("planning")
                    .select("id")
                    .eq("patient_id", patient_id)
                    .eq("aidant_id", req.user.userId)
                    .maybeSingle();

                if (error || !planning) {
                    return res.status(403).json({ error: "Vous n'êtes pas assigné à ce patient" });
                }
            }

            // Upload vers Supabase Storage
            const originalName = documentFile.originalname;
            const extension = originalName.split('.').pop();
            const fileName = `documents/${patient_id}/${Date.now()}_${Math.random().toString(36).substring(7)}.${extension}`;
            
            const { error: uploadError } = await supabase.storage
                .from("documents")
                .upload(fileName, documentFile.buffer, {
                    contentType: documentFile.mimetype,
                    upsert: false,
                });

            if (uploadError) {
                console.error("❌ Erreur upload:", uploadError);
                throw uploadError;
            }

            const { data: urlData } = supabase.storage.from("documents").getPublicUrl(fileName);
            const documentUrl = urlData.publicUrl;

            // Insertion du message
            const messageData = {
                patient_id,
                sender_id: req.user.userId,
                content: documentUrl,
                photo_url: null,
                is_photo: false,
                type_media: "DOCUMENT",
                titre_media: originalName,
                reply_to_id: reply_to_id || null,
                reactions: {},
                visibility: visibility || 'all', 
            };

            const { error: insertError } = await supabase.from("messages").insert([messageData]);

            if (insertError) throw insertError;

                      // Notification interne + push système
            await notifyMessageRecipients({
                patient_id,
                sender_id: req.user.userId,
                title: "📄 Nouveau document",
                message: "Un nouveau document a été ajouté au dossier.",
                url: "/#feed"
            });
          res.json({ 
              status: "success", 
              document_url: documentUrl,
              filename: originalName
          });

        } catch (err) {
            console.error("❌ Erreur send-document:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

module.exports = router;
