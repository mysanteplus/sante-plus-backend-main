// routes/commandes.js - VERSION COMPLÈTE PRODUCTION

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { checkActiveSubscription } = require("../utils");
const { createNotification } = require("./notifications");
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
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Type de fichier non supporté'), false);
        }
    }
});

// ============================================================
// 💊 1. CRÉER UNE COMMANDE (Famille avec/sans patient, Coordinateur)
// ============================================================

router.post("/add", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
    const { patient_id, liste_medocs, type_commande, urgent, images } = req.body;
    
    console.log("📦 Création commande - Images reçues:", images);
    
    // ✅ VÉRIFICATION ABONNEMENT RÉELLE (sauf pour coordinateur)
    if (req.user.role !== "COORDINATEUR") {
        const hasSubscription = await checkActiveSubscription(req.user.userId, req.user.role);
        if (!hasSubscription) {
            console.log(`❌ Commande refusée: abonnement inactif pour ${req.user.userId}`);
            return res.status(403).json({ 
                error: "Abonnement requis pour passer une commande. Veuillez souscrire ou renouveler votre abonnement." 
            });
        }
        console.log(`✅ Abonnement actif pour ${req.user.userId}`);
    }
    
    // Récupérer le type de compte de l'utilisateur
    const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("type_compte")
        .eq("id", req.user.userId)
        .single();
    
    const isSansPatient = profile?.type_compte === 'SANS_PATIENT';
    
    // Vérifications
    if (!isSansPatient && !patient_id) {
        return res.status(400).json({ error: "ID patient requis pour ce type de compte" });
    }
    
    if (isSansPatient && patient_id) {
        return res.status(400).json({ error: "Vous ne pouvez pas commander pour un patient" });
    }

    if (!isSansPatient && req.user.role === "FAMILLE") {
        const { data: patient, error: patientCheckErr } = await supabase
            .from("patients")
            .select("id, famille_user_id")
            .eq("id", patient_id)
            .eq("famille_user_id", req.user.userId)
            .maybeSingle();

        if (patientCheckErr) throw patientCheckErr;

        if (!patient) {
            return res.status(403).json({
                error: "Accès non autorisé à ce dossier patient"
            });
        }
    }
    
    try {
        let commandeData = {
            liste_medocs,
            type_commande: type_commande || 'AUTRE',
            urgent: urgent || false,
            images: images || [],
            statut: "En attente",
            demandeur_id: req.user.userId
        };
        
        if (isSansPatient) {
            commandeData.user_id = req.user.userId;
            commandeData.patient_id = null;
        } else {
            commandeData.patient_id = patient_id;
            commandeData.user_id = null;
        }
        
        const { data: commande, error } = await supabase
            .from("commandes_meds")
            .insert([commandeData])
            .select()
            .single();

        if (error) throw error;
        
        const channel = getRealtimeChannel();
        await channel.send({
            type: 'broadcast',
            event: 'commande_updated',
            payload: {
                id: commande.id,
                patient_id: commande.patient_id,
                user_id: commande.user_id,
                statut: "En attente",
                action: "created"
            }
        });
        
        res.json({ status: "success", message: "Demande enregistrée." });
        
    } catch (err) {
        console.error("❌ Erreur création commande:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 📋 2. AIDANT PREND EN CHARGE UNE COMMANDE
// ============================================================

router.post("/accept", middleware(["AIDANT"]), async (req, res) => {
    const { commandeId } = req.body;
    
    console.log(`🔵 Aidant ${req.user.userId} tente de prendre commande ${commandeId}`);
    
    try {
        const { data: commande, error: checkErr } = await supabase
            .from("commandes_meds")
            .select("id, statut, patient_id, user_id")
            .eq("id", commandeId)
            .single();
        
        if (checkErr || !commande) {
            return res.status(404).json({ error: "Commande introuvable" });
        }
        
        if (commande.statut !== "En attente") {
            return res.status(400).json({ error: "Cette commande n'est plus disponible" });
        }
        
        const { data: updated, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id: req.user.userId,
                statut: "En cours de livraison"
            })
            .eq("id", commandeId)
            .select(`
                *,
                patient:patients(nom_complet, famille_user_id),
                demandeur:profiles!commandes_meds_user_id_fkey(id, nom)
            `)
            .single();
        
        if (error) throw error;
        
        const channel = getRealtimeChannel();
        await channel.send({
            type: "broadcast",
            event: "commande_updated",
            payload: {
                id: updated.id,
                patient_id: updated.patient_id,
                user_id: updated.user_id,
                statut: "En cours de livraison",
                action: "accepted",
                aidant_id: req.user.userId
            }
        });

        const familleId = updated.patient?.famille_user_id || updated.user_id;

        if (familleId) {
            await createNotification(
                familleId,
                "🚚 Commande en cours",
                "Un livreur a pris votre commande en charge.",
                "commande",
                "/#commandes"
            );
        }
        
        res.json({ status: "success", commande: updated });
        
    } catch (err) {
        console.error("❌ Erreur accept:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 💰 3. CONFIRMER & ASSIGNER (Coordinateur)
// ============================================================

router.post("/confirm", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId, aidant_id } = req.body;
    
    try {
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();
        
        if (aidantErr || !aidant) {
            return res.status(400).json({ error: "Aidant invalide" });
        }
        
        const { data: cmd, error } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id,
                statut: "En cours de livraison"
            })
            .eq("id", commandeId)
            .select('*, patient:patients(nom_complet, famille_user_id)')
            .single();

        if (error) throw error;

        await createNotification(
            aidant_id,
            "📦 Nouvelle commande à livrer",
            `Une commande pour ${cmd.patient?.nom_complet || "un patient"} vous a été assignée.`,
            "commande",
            "/#commandes"
        );

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur confirmation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 📋 4. ASSIGNER UNE COMMANDE À UN AIDANT (Coordinateur)
// ============================================================

router.post("/assign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commande_id, aidant_id, notes } = req.body;
    
    console.log("🔵 Assignation commande:", { commande_id, aidant_id });
    
    if (!commande_id || !aidant_id) {
        return res.status(400).json({ error: "commande_id et aidant_id requis" });
    }
    
    try {
        const { data: commande, error: checkErr } = await supabase
            .from("commandes_meds")
            .select("id, statut, patient_id")
            .eq("id", commande_id)
            .single();
        
        if (checkErr || !commande) {
            return res.status(404).json({ error: "Commande introuvable" });
        }
        
        if (commande.statut !== "En attente") {
            return res.status(400).json({ error: "Cette commande n'est plus disponible" });
        }
        
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();
        
        if (aidantErr || !aidant) {
            return res.status(400).json({ error: "Aidant invalide" });
        }
        
        const { data: updated, error: updateErr } = await supabase
            .from("commandes_meds")
            .update({
                aidant_id: aidant_id,
                statut: "En cours de livraison",
                notes_coordinateur: notes || null,
                assigned_by: req.user.userId,
                assigned_at: new Date().toISOString()
            })
            .eq("id", commande_id)
            .select(`
                *,
                patient:patients(nom_complet, famille_user_id),
                demandeur:profiles!commandes_meds_user_id_fkey(id, nom)
            `)
            .single();

        if (updateErr) {
            console.error("❌ Erreur update:", updateErr);
            throw updateErr;
        }

        await createNotification(
            aidant_id,
            "📦 Nouvelle commande à livrer",
            "Une commande vous a été assignée.",
            "commande",
            "/#commandes"
        );
        
        const familleId = updated.patient?.famille_user_id || updated.user_id;
        
        if (familleId) {
            await createNotification(
                familleId,
                "🚚 Commande assignée",
                "Un livreur a été assigné à votre commande.",
                "commande",
                "/#commandes"
            );
        }
        
        const channel = getRealtimeChannel();
        await channel.send({
            type: 'broadcast',
            event: 'commande_updated',
            payload: {
                id: updated.id,
                patient_id: updated.patient_id,
                statut: "En cours de livraison",
                action: "assigned"
            }
        });

        res.json({ status: "success", message: "Commande assignée à l'aidant" });
        
    } catch (err) {
        console.error("❌ Erreur assignation:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ✅ 5. VALIDER LA LIVRAISON (Coordinateur)
// ============================================================

router.post("/validate", middleware(["COORDINATEUR"]), async (req, res) => {
    const { commandeId } = req.body;
    
    try {
        const { data: commande, error } = await supabase
            .from("commandes_meds")
            .update({
                statut: "Validée"
            })
            .eq("id", commandeId)
            .select(`
                *,
                patient:patients(nom_complet, famille_user_id),
                demandeur:profiles!commandes_meds_user_id_fkey(id, nom)
            `)
            .single();
        
        if (error) throw error;
        
        const familleId = commande.patient?.famille_user_id || commande.user_id;

        const nomCommande = commande.patient?.nom_complet
            ? commande.patient.nom_complet
            : "votre commande personnelle";

        if (familleId) {
            await createNotification(
                familleId,
                "✅ Livraison validée",
                `La livraison pour ${nomCommande} a été validée par la coordination.`,
                "commande",
                "/#commandes"
            );
        }
        
        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur validate:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 📦 6. AIDANT LIVRE LA COMMANDE (avec plusieurs photos)
// ============================================================

router.post("/:id/deliver", middleware(["AIDANT"]), upload.array('photos', 5), async (req, res) => {
    console.log("🔵 [DELIVER] Début");
    console.log("🔵 Param ID:", req.params.id);
    console.log("🔵 Body:", req.body);
    console.log("🔵 Files reçus:", req.files ? req.files.length : 0);
    
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

    for (const photo of photoFiles) {
        if (photo.size > 10 * 1024 * 1024) {
            return res.status(400).json({ error: "Une photo dépasse 10MB" });
        }
    }

    try {
        console.log("🔍 Vérification commande:", commandeId);
        const { data: commande, error: checkErr } = await supabase
            .from("commandes_meds")
            .select("id, aidant_id, patient_id, user_id, statut")
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

        console.log("📤 Upload des photos vers Supabase Storage...");
        const uploadedPhotos = [];
        
        for (let i = 0; i < photoFiles.length; i++) {
            const photo = photoFiles[i];
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
            
            const { data: urlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
            uploadedPhotos.push(urlData.publicUrl);
            console.log(`✅ Upload réussi: ${urlData.publicUrl}`);
        }
        
        console.log(`📸 ${uploadedPhotos.length} photos uploadées avec succès`);
        console.log("📸 URLs:", uploadedPhotos);

        console.log("📝 Mise à jour de la commande dans Supabase...");
        const updateData = {
            aidant_id: req.user.userId,
            statut: "Livrée",
            date_livraison: new Date().toISOString(),
            photos_livraison: uploadedPhotos,
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

        const { data: updatedCommande, error: verifyError } = await supabase
            .from("commandes_meds")
            .select("photos_livraison")
            .eq("id", commandeId)
            .single();
        
        if (!verifyError && updatedCommande) {
            console.log("✅ Vérification après update - photos_livraison:", updatedCommande.photos_livraison);
        }

        let familleId = commande.user_id;
        let nomCommande = "votre commande personnelle";
        
        if (commande.patient_id) {
            const { data: patient, error: patientErr } = await supabase
                .from("patients")
                .select("nom_complet, famille_user_id")
                .eq("id", commande.patient_id)
                .maybeSingle();
        
            if (!patientErr && patient) {
                familleId = patient.famille_user_id;
                nomCommande = patient.nom_complet;
            }
        }
        
        if (familleId) {
            try {
                await createNotification(
                    familleId,
                    "📦 Commande livrée",
                    `Votre commande pour ${nomCommande} a été livrée.`,
                    "commande",
                    "/#commandes"
                );
            } catch (pushErr) {
                console.warn("⚠️ Notification livraison échouée:", pushErr.message);
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

// ============================================================
// 📋 7. LISTER LES COMMANDES (FILTRÉ PAR RÔLE)
// ============================================================

router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        const { data: profile } = await supabase
            .from("profiles")
            .select("type_compte")
            .eq("id", req.user.userId)
            .single();
        
        const isSansPatient = profile?.type_compte === 'SANS_PATIENT';
        
        let query = supabase.from("commandes_meds").select(`
            *,
            patient:patients (id, nom_complet, adresse, famille_user_id),
            demandeur:profiles!commandes_meds_demandeur_id_fkey (id, nom, role),
            aidant:profiles!commandes_meds_aidant_id_fkey (id, nom, telephone)
        `);

        if (req.user.role === "COORDINATEUR") {
            // Coordinateur : voit tout
        }
        else if (req.user.role === "AIDANT") {
            // Récupérer les patients assignés à cet aidant
            const { data: assignments, error: assignErr } = await supabase
                .from("planning")
                .select("patient_id")
                .eq("aidant_id", req.user.userId)
                .eq("est_actif", true);
            
            if (assignErr) {
                console.error("❌ Erreur récupération assignations:", assignErr);
                return res.status(500).json({ error: assignErr.message });
            }
            
            const assignedPatientIds = assignments ? assignments.map(a => a.patient_id) : [];
            
            if (assignedPatientIds.length > 0) {
                query = query.or(`patient_id.in.(${assignedPatientIds.join(',')}),aidant_id.eq.${req.user.userId}`);
            } else {
                query = query.eq("aidant_id", req.user.userId);
            }
        }
        else if (req.user.role === "FAMILLE") {
            if (isSansPatient) {
                query = query.eq("user_id", req.user.userId);
            } else {
                const { data: patients } = await supabase
                    .from("patients")
                    .select("id")
                    .eq("famille_user_id", req.user.userId);
                
                if (!patients || patients.length === 0) {
                    return res.json([]);
                }
                const patientIds = patients.map(p => p.id);
                query = query.in("patient_id", patientIds);
            }
        }

        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        
        console.log(`📦 ${data.length} commandes retournées pour ${req.user.role}`);
        res.json(data);
    } catch (err) {
        console.error("❌ Erreur liste commandes:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 📦 8. COMMANDES PERSONNELLES (pour comptes SANS_PATIENT)
// ============================================================

router.get("/mes-commandes", middleware(["FAMILLE"]), async (req, res) => {
    try {
        const { data: profile } = await supabase
            .from("profiles")
            .select("type_compte")
            .eq("id", req.user.userId)
            .single();
        
        if (profile?.type_compte !== 'SANS_PATIENT') {
            return res.status(403).json({ error: "Cette route est réservée aux comptes sans patient" });
        }
        
        const { data, error } = await supabase
            .from("commandes_meds")
            .select(`
                *,
                demandeur:profiles!commandes_meds_demandeur_id_fkey (id, nom, role),
                aidant:profiles!commandes_meds_aidant_id_fkey (id, nom, telephone)
            `)
            .eq("user_id", req.user.userId)
            .order("created_at", { ascending: false });
        
        if (error) throw error;
        res.json(data || []);
        
    } catch (err) {
        console.error("❌ Erreur mes-commandes:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ✅ 9. COORDINATEUR - VALIDER TOUTES LES LIVRAISONS DU JOUR
// ============================================================

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

// ============================================================
// 📸 10. UPLOADER UNE IMAGE POUR UNE COMMANDE
// ============================================================

router.post("/upload-image", middleware(["FAMILLE", "AIDANT", "COORDINATEUR"]), upload.single('image'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Aucune image" });
        
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

// ============================================================
// ⏰ 11. AUTO-ASSIGNATION DES COMMANDES (appelé par cron)
// ============================================================

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
            
            await createNotification(
                aidantId,
                cmd.urgent ? "⚠️ Commande urgente (auto-assignée)" : "📦 Nouvelle commande (auto-assignée)",
                `Une commande ${cmd.urgent ? "urgente " : ""}vous a été automatiquement assignée.`,
                "commande",
                "/#commandes"
            );
            
            console.log(`✅ Commande ${cmd.id} auto-assignée à ${aidantNom}`);
        }
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = router;
module.exports.autoAssignPendingCommands = autoAssignPendingCommands;
