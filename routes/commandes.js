const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const multer = require("multer");
const { getRealtimeChannel } = require("../utils");


const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        fieldSize: 10 * 1024 * 1024, // 10MB
        fields: 10,
        files: 1,
        parts: 20
    },
    // Filtrer les types de fichiers
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Type de fichier non supporté'), false);
        }
    }
});

/**
 * 💊 1. CRÉER UNE COMMANDE (Famille ou Coordinateur)
 */
router.post("/add", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
    const { patient_id, liste_medocs, type_commande, urgent, images } = req.body;
    
    console.log("📦 Création commande - Images reçues:", images);
    
    try {
            const { data: commande, error } = await supabase
                .from("commandes_meds")
                .insert([
                    {
                        patient_id,
                        demandeur_id: req.user.userId,
                        liste_medocs,
                        type_commande: type_commande || 'AUTRE',
                        urgent: urgent || false,
                        images: images || [],
                        statut: "En attente",
                    },
                ])
                .select()
                .single();

        if (error) throw error;
        
        res.json({ status: "success", message: "Demande enregistrée." });


                // Après avoir créé la commande
        const channel = getRealtimeChannel();
        
        await channel.send({
            type: 'broadcast',
            event: 'commande_updated',
            payload: {
                id: commande.id,
                patient_id: commande.patient_id,
                statut: "En attente",
                action: "created"
            }
        });
   
    } catch (err) {
        console.error("❌ Erreur création commande:", err);
        res.status(500).json({ error: err.message });
    }
});

 router.post("/accept", middleware(["AIDANT"]), async (req, res) => {
    const { commandeId } = req.body;
    
    try {
        const { data: commande, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id: req.user.userId,
                statut: "En cours de livraison"
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();
        
        if (error) throw error;
        
        // Notifier la famille
        if (commande.patient.famille_user_id) {
            sendPushNotification(
                commande.patient.famille_user_id,
                "🚚 Commande en cours",
                `${commande.patient.nom_complet} - Un livreur a pris votre commande en charge.`,
                "/#commandes"
            );
        }
        
        res.json({ status: "success" });


                // Après avoir créé la commande

        const channel = getRealtimeChannel();
        await channel.send({
            type: 'broadcast',
            event: 'commande_updated',
            payload: {
                id: commande.id,
                patient_id: commande.patient_id,
                statut: "En cours de livraison",
                action: "accepted"
            }
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/**
 * 💰 2. CONFIRMER LE PRIX & ASSIGNER (Coordinateur)
 */
router.post("/confirm", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId, aidant_id } = req.body;
    
    try {
        // Vérifier que l'aidant existe
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();
        
        if (aidantErr || !aidant) {
            return res.status(400).json({ error: "Aidant invalide" });
        }
        
        // Assigner l'aidant à la commande (sans prix)
        const { data: cmd, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id,
                statut: "En cours de livraison"  // Nouveau statut
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();

        if (error) throw error;

        // Notification à l'aidant
        sendPushNotification(
            aidant_id,
            "📦 Nouvelle commande à livrer",
            `Une commande pour ${cmd.patient.nom_complet} vous a été assignée.`,
            "/#commandes"
        );

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur confirmation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📋 ASSIGNER UNE COMMANDE À UN AIDANT (Coordinateur)
 */
router.post("/assign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId, aidant_id, notes } = req.body;
    
    try {
        // Vérifier que l'aidant existe
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();
        
        if (aidantErr || !aidant) {
            return res.status(400).json({ error: "Aidant invalide" });
        }
        
        // Assigner l'aidant à la commande
        const { data: cmd, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id: aidant_id,
                statut: "En cours",
                notes_coordinateur: notes || null
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();

        if (error) throw error;

        // Notification à l'aidant
        sendPushNotification(
            aidant_id,
            "📦 Nouvelle commande à livrer",
            `Une commande pour ${cmd.patient.nom_complet} vous a été assignée.`,
            "/#commandes"
        );

        // Notification à la famille
        if (cmd.patient.famille_user_id) {
            sendPushNotification(
                cmd.patient.famille_user_id,
                "🚚 Commande en cours",
                `Votre commande pour ${cmd.patient.nom_complet} a été prise en charge.`,
                "/#commandes"
            );
        }

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur assignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * ✅ VALIDER LA LIVRAISON (Coordinateur)
 */
router.post("/validate", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId } = req.body;
    
    try {
        const { data: commande, error } = await supabase
            .from("commandes_meds")
            .update({
                statut: "Validée"
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();
        
        if (error) throw error;
        
        // Notification à la famille
        if (commande.patient.famille_user_id) {
            sendPushNotification(
                commande.patient.famille_user_id,
                "✅ Livraison validée",
                `La livraison pour ${commande.patient.nom_complet} a été validée par la coordination.`,
                "/#commandes"
            );
        }
        
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



/**
 * 📦 AIDANT LIVRE LA COMMANDE (avec plusieurs photos)
 */
/**
 * 📦 AIDANT LIVRE LA COMMANDE (avec plusieurs photos) - VERSION CORRIGÉE
 */
router.post("/:id/deliver", middleware(["AIDANT"]), upload.array('photos', 5), async (req, res) => {
    console.log("🔵 [DELIVER] Début");
    console.log("🔵 Param ID:", req.params.id);
    console.log("🔵 Body:", req.body);
    console.log("🔵 Files reçus:", req.files ? req.files.length : 0);
    
    // Afficher les détails des fichiers pour debug
    if (req.files && req.files.length > 0) {
        req.files.forEach((file, i) => {
            console.log(`📸 Fichier ${i}:`, {
                originalname: file.originalname,
                size: file.size,
                mimetype: file.mimetype
            });
        });
    }
    
    const commandeId = req.params.id;
    const { notes_livraison } = req.body;
    const photoFiles = req.files || [];
    
    if (!commandeId) {
        console.error("❌ ID commande manquant");
        return res.status(400).json({ error: "ID commande manquant" });
    }

    if (photoFiles.length === 0) {
        console.error("❌ Aucune photo reçue");
        return res.status(400).json({ error: "Au moins une photo obligatoire" });
    }

    // Vérifier la taille de chaque photo
    for (const photo of photoFiles) {
        if (photo.size > 10 * 1024 * 1024) {
            return res.status(400).json({ error: "Une photo dépasse 10MB" });
        }
    }

    try {
        // 1. Vérifier que la commande existe
        console.log("🔍 Vérification commande:", commandeId);
        const { data: commande, error: checkErr } = await supabase
            .from("commandes_meds")
            .select("id, aidant_id, patient_id, statut")
            .eq("id", commandeId)
            .single();
        
        if (checkErr) {
            console.error("❌ Erreur check commande:", checkErr);
            return res.status(404).json({ error: "Commande introuvable" });
        }
        
        if (!commande) {
            return res.status(404).json({ error: "Commande introuvable" });
        }

        if (commande.statut === "Livrée") {
            return res.status(400).json({ error: "Commande déjà livrée" });
        }

        // 2. Upload des photos vers Supabase Storage
        console.log("📤 Upload des photos vers Supabase Storage...");
        const uploadedPhotos = [];
        
        for (let i = 0; i < photoFiles.length; i++) {
            const photo = photoFiles[i];
            // Générer un nom de fichier unique
            const timestamp = Date.now();
            const random = Math.random().toString(36).substring(7);
            const extension = photo.originalname.split('.').pop() || 'jpg';
            const fileName = `livraisons/${commandeId}_${timestamp}_${i}_${random}.${extension}`;
            
            console.log(`📸 Upload fichier ${i+1}/${photoFiles.length}: ${fileName}`);
            
            const { error: uploadError } = await supabase.storage
                .from("preuves")
                .upload(fileName, photo.buffer, {
                    contentType: photo.mimetype || 'image/jpeg',
                    upsert: false,
                    cacheControl: '3600'
                });
            
            if (uploadError) {
                console.error("❌ Erreur upload:", uploadError);
                if (uploadError.message?.includes("bucket")) {
                    return res.status(500).json({ error: "Bucket 'preuves' non configuré. Contactez l'administrateur." });
                }
                throw new Error("Upload échoué: " + uploadError.message);
            }
            
            // Récupérer l'URL publique
            const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
            uploadedPhotos.push(urlData.publicUrl);
            console.log(`✅ Upload réussi: ${urlData.publicUrl}`);
        }
        
        console.log(`📸 ${uploadedPhotos.length} photos uploadées avec succès`);
        console.log("📸 URLs:", uploadedPhotos);

        // 3. Mettre à jour la commande dans la base de données
        console.log("📝 Mise à jour de la commande dans Supabase...");
        const updateData = {
            aidant_id: req.user.userId,
            statut: "Livrée",
            date_livraison: new Date().toISOString(),
            photos_livraison: uploadedPhotos,  // ✅ Tableau d'URLs
            notes_livraison: notes_livraison || null
        };
        
        console.log("📝 Update data:", updateData);
        
        const { error: updateError } = await supabase
            .from("commandes_meds")
            .update(updateData)
            .eq("id", commandeId);
        
        if (updateError) {
            console.error("❌ Erreur update:", updateError);
            throw new Error("Mise à jour échouée: " + updateError.message);
        }

        // 4. Vérifier que les données ont bien été sauvegardées
        const { data: updatedCommande, error: verifyError } = await supabase
            .from("commandes_meds")
            .select("photos_livraison")
            .eq("id", commandeId)
            .single();
        
        if (!verifyError && updatedCommande) {
            console.log("✅ Vérification après update - photos_livraison:", updatedCommande.photos_livraison);
        }

        // 5. Notifications (optionnel)
        const { data: patient, error: patientErr } = await supabase
            .from("patients")
            .select("nom_complet, famille_user_id")
            .eq("id", commande.patient_id)
            .single();

        if (!patientErr && patient && patient.famille_user_id) {
            try {
                await sendPushNotification(
                    patient.famille_user_id,
                    "📦 Commande livrée",
                    `Votre commande pour ${patient.nom_complet} a été livrée.`,
                    "/#commandes"
                );
            } catch (pushErr) {
                console.warn("⚠️ Push notification échouée:", pushErr.message);
            }
        }

        console.log("✅ Livraison confirmée pour commande:", commandeId);
        res.status(200).json({ 
            success: true,
            status: "success", 
            message: "Livraison confirmée", 
            photos: uploadedPhotos 
        });

    } catch (err) {
        console.error("❌ Erreur livraison:", err);
        res.status(500).json({ 
            error: err.message || "Erreur interne du serveur"
        });
    }
});
/**
 * 📋 4. LISTER LES COMMANDES (Filtrage par rôle)
 */
router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        let query = supabase.from("commandes_meds").select(`
            *,
            patient:patients (id, nom_complet, adresse, famille_user_id),
            demandeur:profiles!commandes_meds_demandeur_id_fkey (id, nom, role),
            aidant:profiles!commandes_meds_aidant_id_fkey (id, nom, telephone)
        `);

        if (req.user.role === "AIDANT") {
            // ✅ L'aidant voit TOUTES les commandes de ses patients assignés
            // Récupérer les IDs des patients assignés à l'aidant
            const { data: assignments } = await supabase
                .from("planning")
                .select("patient_id")
                .eq("aidant_id", req.user.userId)
                .eq("est_actif", true);
            
            const patientIds = assignments ? assignments.map(a => a.patient_id) : [];
            
            if (patientIds.length === 0) {
                return res.json([]);
            }
            
            // L'aidant voit toutes les commandes de ses patients (même en attente)
            query = query.in("patient_id", patientIds);
        } 
        else if (req.user.role === "FAMILLE") {
            const { data: patients } = await supabase
                .from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId);
            
            if (!patients || patients.length === 0) return res.json([]);
            const patientIds = patients.map(p => p.id);
            query = query.in("patient_id", patientIds);
        }

        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/**
 * ✅ COORDINATEUR - VALIDER TOUTES LES LIVRAISONS DU JOUR
 */
router.post("/validate-all", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const { data, error } = await supabase
            .from("commandes_meds")
            .update({ 
                statut: "Validée",
                validee_le: new Date().toISOString(),
                validee_par: req.user.userId
            })
            .eq("statut", "Livrée")
            .gte("date_livraison", `${today}T00:00:00`)
            .lte("date_livraison", `${today}T23:59:59`);
        
        if (error) throw error;
        
        res.json({ status: "success", validees: data?.length || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



/**
 * ⏰ AUTO-ASSIGNATION DES COMMANDES (appelé par cron)
 */


// Exposer la fonction pour le cron

router.post("/upload-image", middleware(["FAMILLE", "AIDANT", "COORDINATEUR"]), upload.single('image'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Aucune image" });
        
        // ❌ ANCIEN (créait un dossier "commandes" dans le bucket "commandes")
        // const fileName = `commandes/${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
        
        // ✅ NOUVEAU (fichier directement à la racine du bucket)
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
        
        console.log("📤 Upload vers:", fileName);
        
        const { error } = await supabase.storage
            .from("commandes")
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });
        
        if (error) throw error;
        
        const { data: urlData } = supabase.storage.from("commandes").getPublicUrl(fileName);
        
        console.log("✅ URL générée:", urlData.publicUrl);
        
        res.json({ url: urlData.publicUrl });
    } catch (err) {
        console.error("❌ Erreur upload image:", err);
        res.status(500).json({ error: err.message });
    }
});

// Fonction auto-assignation
async function autoAssignPendingCommands() {
    console.log("🔍 [AUTO-ASSIGN] Début de la vérification...");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    
    const { data: pendingCommands, error: fetchError } = await supabase
        .from("commandes_meds")
        .select("id, patient_id, urgent")
        .eq("statut", "En attente")
        .lt("created_at", tenMinutesAgo);
    
    if (fetchError || !pendingCommands?.length) {
        console.log("📦 Aucune commande à assigner automatiquement");
        return;
    }
    
    console.log(`📦 ${pendingCommands.length} commande(s) à assigner auto`);
    
    for (const cmd of pendingCommands) {
        const { data: availableAidants } = await supabase
            .from("planning")
            .select("aidant_id, aidant:profiles!aidant_id(nom)")
            .eq("patient_id", cmd.patient_id)
            .eq("est_actif", true);
        
        if (availableAidants?.length) {
            const aidantId = availableAidants[0].aidant_id;
            const aidantNom = availableAidants[0].aidant?.nom;
            
            await supabase
                .from("commandes_meds")
                .update({ 
                    aidant_id: aidantId,
                    statut: "En cours",
                    auto_assigned: true,
                    auto_assigned_at: new Date().toISOString()
                })
                .eq("id", cmd.id);
            
            await sendPushNotification(
                aidantId,
                cmd.urgent ? "⚠️ Commande urgente (auto-assignée)" : "📦 Nouvelle commande (auto-assignée)",
                `Une commande ${cmd.urgent ? "urgente " : ""}vous a été automatiquement assignée.`,
                "/#commandes"
            );
            
            console.log(`✅ Commande ${cmd.id} auto-assignée à ${aidantNom}`);
        }
    }
}

// Exporter correctement
module.exports = router;
module.exports.autoAssignPendingCommands = autoAssignPendingCommands;
