//VERSION COMPLÈTE AVEC LA ROUTE PHOTO

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");  
const { createNotification } = require("./notifications");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { sendPush } = require("../firebaseAdmin");


// ============================================================
// 📥 1. LIRE LE FIL D'ACTUALITÉ
// ============================================================
router.get(
  "/",
  middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
  async (req, res) => {
    const { patient_id, message_id } = req.query;
    const currentUserId = req.user.userId;
    const currentRole = req.user.role;

    try {
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

        // Vérifier les droits d'accès
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
// ❤️ 2. AJOUTER UNE RÉACTION
// ============================================================
router.post(
  "/react",
  middleware(["FAMILLE", "COORDINATEUR"]),
  async (req, res) => {
    const { message_id, reaction_type } = req.body;

    try {
      const { data: msg, error: fetchErr } = await supabase
        .from("messages")
        .select("reactions")
        .eq("id", message_id)
        .single();

      if (fetchErr) throw fetchErr;

      let reactions = msg.reactions || {};
      reactions[reaction_type] = (reactions[reaction_type] || 0) + 1;

      const { error: updateErr } = await supabase
        .from("messages")
        .update({ reactions })
        .eq("id", message_id);

      if (updateErr) throw updateErr;

      res.json({ status: "success", reactions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
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

            // 🔔 =========================
            // 🔥 PUSH NOTIFICATION (CORRIGÉ)
            // =========================

            // ✅ récupérer les bons utilisateurs liés au patient
            const { data: patientUsers, error: patientUsersError } = await supabase
                .from("patients")
                .select("famille_user_id, coordonnateur_id")
                .eq("id", patient_id)
                .single();

            if (patientUsersError) {
                console.error("❌ Erreur patient:", patientUsersError);
            }

            const targetIds = [
                patientUsers?.famille_user_id,
                patientUsers?.coordonnateur_id
            ].filter(id => id && id !== sender_id);

            const { data: users } = await supabase
                .from("profiles")
                .select("push_token, id")
                .in("id", targetIds);

            if (users && users.length > 0) {
                await Promise.all(
                    users
                        .filter(u => u.push_token)
                        .map(u =>
                            sendPush(
                                u.push_token,
                                "💬 Nouveau message",
                                content || "📷 Photo"
                            )
                        )
                );
            } else {
                console.log("⚠️ Aucun utilisateur à notifier");
            }

            // 🔔 =========================
            // 🔁 TON CODE EXISTANT (INTOUCHÉ)
            // =========================

            const { data: patient } = await supabase
                .from("patients")
                .select("famille_user_id, nom_complet")
                .eq("id", patient_id)
                .single();

            if (patient && patient.famille_user_id && req.user.role !== "FAMILLE") {
                let notificationTitle = "📝 Nouveau message";
                let notificationBody = `Nouveau message dans le journal de ${patient.nom_complet}`;

                if (is_photo) {
                    notificationTitle = "📸 Nouvelle photo";
                    notificationBody = `Une nouvelle photo a été ajoutée au journal de ${patient.nom_complet}`;
                }

                if (type_media === 'DOCUMENT') {
                    notificationTitle = "📄 Nouveau document";
                    notificationBody = `Un nouveau document a été ajouté pour ${patient.nom_complet}`;
                }

                sendPushNotification(
                    patient.famille_user_id,
                    notificationTitle,
                    notificationBody,
                    "/#feed"
                );
            }

            res.json({ status: "success" });

        } catch (err) {
            console.error("❌ Erreur envoi message:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);


// ============================================================
// 📸 4. ENVOYER UNE PHOTO (VERSION FINALE - SANS type_media)
// ============================================================
/**
 * 📸 ENVOYER UNE PHOTO (VERSION CORRIGÉE)
 */
router.post(
    "/send-photo",
    middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]),
    upload.single("photo"),
    async (req, res) => {
        console.log("🔵 [send-photo] Route appelée");
        
        const { patient_id, reply_to_id, caption, visibility } = req.body;
        const photoFile = req.file;

        // Vérifications de base
        if (!photoFile) {
            return res.status(400).json({ error: "Photo requise" });
        }
        if (!patient_id) {
            return res.status(400).json({ error: "ID patient requis" });
        }

        try {
            // ============================================================
            // 1. VÉRIFICATIONS DE SÉCURITÉ
            // ============================================================
            
            // Vérification pour la FAMILLE
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

            // Vérification pour l'AIDANT
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

            // ============================================================
            // 2. UPLOAD VERS SUPABASE STORAGE
            // ============================================================
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

            // Récupérer l'URL publique
            const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
            const photoUrl = urlData.publicUrl;

            // ============================================================
            // 3. CRÉATION DU MESSAGE DANS LA BASE
            // ============================================================
            const messageData = {
                patient_id: patient_id,
                sender_id: req.user.userId,
                content: photoUrl,                    // L'URL de la photo
                photo_url: photoUrl,                  // Pour faciliter l'affichage
                is_photo: true,                       // ← IMPORTANT : flag pour identifier les photos
                type_media: 'STORY',                  // ← Pour le filtrage dans l'onglet STORY
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

            // ============================================================
            // 4. NOTIFICATION À LA FAMILLE (si l'envoyeur n'est pas la famille)
            // ============================================================
            const { data: patient } = await supabase
                .from("patients")
                .select("famille_user_id, nom_complet")
                .eq("id", patient_id)
                .single();

            if (patient && patient.famille_user_id && req.user.role !== "FAMILLE") {
                // Notification push
                sendPushNotification(
                    patient.famille_user_id,
                    "📸 Nouvelle photo",
                    `Une nouvelle photo a été ajoutée au journal de ${patient.nom_complet}`,
                    "/#feed"
                );
                
                // Notification dans la base
                if (typeof createNotification === 'function') {
                    await createNotification(
                        patient.famille_user_id,
                        "📸 Nouvelle photo",
                        `Une photo a été ajoutée au journal de ${patient.nom_complet}`,
                        "message",
                        "/#feed"
                    );
                }
            }

            // ============================================================
            // 5. RÉPONSE AU CLIENT
            // ============================================================
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

router.post('/mark-read', async (req, res) => {
    try {
        const { patient_id } = req.body;

        if (!patient_id) {
            return res.status(400).json({ error: "patient_id requis" });
        }

        // ⚠️ adapte selon ton système auth
        const userId = req.user?.id || req.body.user_id;

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
            // Vérifications de sécurité (identiques à send-photo)
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

            // Déterminer l'extension et le type
            const originalName = documentFile.originalname;
            const extension = originalName.split('.').pop();
            const isPdf = documentFile.mimetype === 'application/pdf';
            const isDoc = documentFile.mimetype === 'application/msword' || documentFile.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            const isImage = documentFile.mimetype.startsWith('image/');
            
            // Upload vers Supabase Storage
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

            // Déterminer l'icône pour l'affichage
            let iconClass = 'fa-file-pdf';
            let colorClass = 'text-red-500';
            if (isDoc) {
                iconClass = 'fa-file-word';
                colorClass = 'text-blue-500';
            } else if (isImage) {
                iconClass = 'fa-file-image';
                colorClass = 'text-green-500';
            }

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

            // Notification à la famille
            const { data: patient } = await supabase
                .from("patients")
                .select("famille_user_id, nom_complet")
                .eq("id", patient_id)
                .single();

            if (patient && patient.famille_user_id && req.user.role !== "FAMILLE") {
                sendPushNotification(
                    patient.famille_user_id,
                    "📄 Nouveau document",
                    `Un nouveau document a été ajouté au journal de ${patient.nom_complet}`,
                    "/#feed"
                );
            }

            res.json({ 
                status: "success", 
                document_url: documentUrl,
                filename: originalName,
                icon: iconClass,
                color: colorClass
            });

        } catch (err) {
            console.error("❌ Erreur send-document:", err.message);
            res.status(500).json({ error: err.message });
        }
    }
);



module.exports = router;
