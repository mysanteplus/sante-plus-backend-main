const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const { createNotification } = require("./notifications");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { getRealtimeChannel } = require("../utils");


// Optionnel : logger la structure pour vérifier
(async () => {
    const { data, error } = await supabase
        .from("visites")
        .select("planning_id")
        .limit(1);
    if (error) {
        console.error("❌ Erreur vérification planning_id:", error);
    } else {
        console.log("✅ planning_id existe bien dans la table visites");
    }
})();

// ============================================================
// ▶️ 1. DÉMARRER UNE VISITE
// ============================================================
// ============================================================
// ▶️ 1. DÉMARRER UNE VISITE
// ============================================================
router.post("/start", middleware(["AIDANT"]), async (req, res) => {
    const { patient_id, gps_start } = req.body;

    try {
        // Vérifier que l'aidant est assigné à ce patient
        const { data: planning, error: planningErr } = await supabase
            .from("planning")
            .select("id, date_prevue")
            .eq("patient_id", patient_id)
            .eq("aidant_id", req.user.userId)
            .eq("est_actif", true)
            .maybeSingle();

        if (planningErr || !planning) {
            return res.status(403).json({ 
                error: "Vous n'êtes pas autorisé à intervenir sur ce dossier" 
            });
        }

        // Vérifier qu'il n'y a pas déjà une visite en cours
        const { data: existingVisit, error: existingErr } = await supabase
            .from("visites")
            .select("id, statut")
            .eq("patient_id", patient_id)
            .eq("aidant_id", req.user.userId)
            .in("statut", ["En cours", "En attente"])
            .maybeSingle();

        if (existingErr) throw existingErr;

        if (existingVisit) {
            return res.status(400).json({ 
                error: "Une visite est déjà en cours",
                visite_id: existingVisit.id  
            });
        }

        // Créer la visite
        const { data: visite, error } = await supabase
            .from("visites")
            .insert([{
                patient_id,
                aidant_id: req.user.userId,
                planning_id: planning.id,
                heure_debut: new Date(),
                gps_start: gps_start,
                statut: "En cours",
            }])
            .select(`*, patient:patients(nom_complet, famille_user_id), aidant:profiles!aidant_id(nom)`)
            .single();

        if (error) {
            console.error("❌ Erreur insertion:", error);
            throw error;
        }

        // Mettre à jour le planning
        if (planning.id) {
            await supabase
                .from("planning")
                .update({ statut: "En cours" })
                .eq("id", planning.id);
        }

        try {
                const channel = getRealtimeChannel();
                await channel.send({
                    type: 'broadcast',
                    event: 'visite_updated',
                    payload: {
                        id: visite.id,
                        patient_id: visite.patient_id,
                        statut: "En cours",
                        action: "started",
                        patient_nom: visite.patient?.nom_complet,
                        updated_at: new Date().toISOString()
                    }
                });
            console.log("📡 [REALTIME] Événement 'visite_started' envoyé");
        } catch (realtimeErr) {
            console.warn("⚠️ Erreur envoi Realtime:", realtimeErr.message);
        }

        // Notifier la famille (push notification)
        if (visite.patient && visite.patient.famille_user_id) {
            await sendPushNotification(
                visite.patient.famille_user_id,
                "🔔 Début d'intervention",
                `L'intervenant vient d'arriver au domicile de ${visite.patient.nom_complet}.`,
                "/#feed"
            );

            if (createNotification) {
                await createNotification(
                    visite.patient.famille_user_id,
                    "🔔 Début d'intervention",
                    `${visite.aidant?.nom || "L'aidant"} est arrivé au domicile de ${visite.patient.nom_complet}.`,
                    "visit",
                    "/#feed"
                );
            }
        }

        res.json({ status: "success", visite_id: visite.id });
        
    } catch (err) {
        console.error("❌ Crash Route Start:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// ⏹️ 2. TERMINER UNE VISITE (AVEC AUTO-FEED)
// ============================================================
router.post("/end", middleware(["AIDANT"]), upload.single('photo_visite'), async (req, res) => {
    const { visite_id, activites_faites, notes, gps_end, humeur } = req.body;
    const photoFile = req.file;

    if (!photoFile) return res.status(400).json({ error: "Photo obligatoire." });

    try {
        const fileName = `visites/${visite_id}_${Date.now()}.jpg`;
        await supabase.storage.from("preuves").upload(fileName, photoFile.buffer, { 
            contentType: 'image/jpeg', 
            upsert: true 
        });
        const { data: publicUrlData } = supabase.storage.from("preuves").getPublicUrl(fileName);
        const photoUrl = publicUrlData.publicUrl;

        const { data: v, error: updateError } = await supabase
            .from("visites")
            .update({
                heure_fin: new Date(),
                activites_faites: JSON.parse(activites_faites || "[]"),
                notes,
                humeur,
                photo_url: photoUrl,
                gps_end: gps_end,
                statut: "En attente",  
            })
            .eq("id", visite_id)
            .select(`*, patient:patients(nom_complet, famille_user_id)`)
            .single();

        if (updateError) throw updateError;

        await supabase.from("messages").insert([{
            patient_id: v.patient_id,
            sender_id: req.user.userId,
            content: photoUrl,
            is_photo: true
        }]);

        await supabase.from("messages").insert([{
            patient_id: v.patient_id,
            sender_id: req.user.userId,
            content: `${humeur}|${notes}`,
            is_photo: false
        }]);

        const channel = getRealtimeChannel();
        await channel.send({
            type: 'broadcast',
            event: 'visite_updated',
            payload: {
                id: v.id,
                patient_id: v.patient_id,
                statut: "En attente",
                action: "ended",
                patient_nom: v.patient?.nom_complet,
                updated_at: new Date().toISOString()
            }
        });
        console.log("📡 [REALTIME] Événement 'visite_ended' envoyé");

        if (v.patient && v.patient.famille_user_id) {
            await sendPushNotification(
                v.patient.famille_user_id,
                "📸 Rapport de visite disponible",
                `L'intervention pour ${v.patient.nom_complet} est terminée.`,
                "/#feed"
            );
            
            await createNotification(
                v.patient.famille_user_id,
                "📸 Nouveau rapport de visite",
                `L'intervention est terminée. Une photo est disponible.`,
                "visit",
                "/#feed"
            );
        }

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur fin de visite:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// ✅ 3. VALIDER UNE VISITE (Coordinateur)
// ============================================================
router.post("/validate", middleware(["COORDINATEUR"]), async (req, res) => {
    const { visite_id, statut } = req.body;

    try {
        const { data: visite, error } = await supabase
            .from("visites")
            .update({ statut: statut })  
            .eq("id", visite_id)
            .select(`*, patient:patients(nom_complet, famille_user_id)`)
            .single();

        if (error) throw error;

        // ✅ AJOUTE ICI - Envoyer l'événement Realtime à TOUS les clients
        try {
            const channel = getRealtimeChannel();
            await channel.send({
                type: 'broadcast',
                event: 'visite_updated',
                payload: {
                    id: visite.id,
                    patient_id: visite.patient_id,
                    statut: "En cours",
                    action: "started",
                    patient_nom: visite.patient?.nom_complet,
                    updated_at: new Date().toISOString()
                }
            });
            console.log(`📡 [REALTIME] Événement 'visite_${statut === "Validé" ? "validated" : "rejected"}' envoyé`);
        } catch (realtimeErr) {
            console.warn("⚠️ Erreur envoi Realtime:", realtimeErr.message);
        }

        if (statut === "Validé" && visite.patient.famille_user_id) {
            await sendPushNotification(
                visite.patient.famille_user_id,
                "✅ Bilan validé par la coordination",
                `Le rapport pour ${visite.patient.nom_complet} a été certifié conforme.`,
                "/#feed"
            );

            await createNotification(
                visite.patient.famille_user_id,
                "✅ Visite validée",
                `Le rapport de visite pour ${visite.patient.nom_complet} a été certifié conforme.`,
                "visit",
                "/#feed"
            );
        }

        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur validation:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// 📂 4. LIRE LES VISITES (Filtrage)
// ============================================================
router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        let query = supabase.from("visites").select(`
            *,
            patient:patient_id (id, nom_complet, adresse),
            aidant:aidant_id (id, nom, photo_url)
        `);

        if (req.user.role === "AIDANT") {
            // L'aidant voit toutes ses visites
            query = query.eq("aidant_id", req.user.userId);
        } 
        else if (req.user.role === "FAMILLE") {
            // La famille voit les visites de SON patient
            const { data: patients } = await supabase
                .from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId);
            
            if (!patients || patients.length === 0) {
                return res.json([]);
            }
            
            const patientIds = patients.map(p => p.id);
            
            // ✅ La famille voit TOUTES les visites (En attente + Validé)
            query = query
                .in("patient_id", patientIds)
                .in("statut", ["En attente", "Validé"]);  // ← Les deux statuts
        }
        // COORDINATEUR voit tout

        const { data, error } = await query.order("heure_debut", { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur lecture visites:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// 🛰️ TRACKING GPS
// ============================================================
router.post("/track", middleware(['AIDANT']), async (req, res) => {
    const { visite_id, lat, lng, accuracy } = req.body;
    
    try {
        await supabase.from("positions_live").insert([{
            visite_id,
            aidant_id: req.user.userId,
            lat, 
            lng,
            accuracy: accuracy || 0,
            created_at: new Date()
        }]);

        const { data: visite, error: visitError } = await supabase
            .from("visites")
            .select(`
                id, 
                patient_id, 
                alerte_geofence,
                notifie_arrivee,
                patient:patients(id, lat, lng, rayon_geofence, nom_complet, famille_user_id),
                aidant:profiles!aidant_id(id, nom, photo_url)
            `)
            .eq("id", visite_id)
            .single();

        if (visitError || !visite) {
            console.error("❌ Visite non trouvée:", visitError);
            return res.sendStatus(200);
        }

        if (visite.patient && visite.patient.lat) {
            const distance = getDistance(lat, lng, visite.patient.lat, visite.patient.lng);
            const rayonAutorise = visite.patient.rayon_geofence || 100;

            if (distance > rayonAutorise && !visite.alerte_geofence) {
                await supabase
                    .from("visites")
                    .update({ 
                        alerte_geofence: true,
                        distance_max_constatee: distance 
                    })
                    .eq("id", visite_id);
            } else if (distance <= rayonAutorise && visite.alerte_geofence) {
                await supabase
                    .from("visites")
                    .update({ alerte_geofence: false })
                    .eq("id", visite_id);
            }

            const alreadyNotified = visite.notifie_arrivee;
            const seuilNotification = 50;
            
            if (distance <= seuilNotification && !alreadyNotified && visite.patient.famille_user_id) {
                await supabase
                    .from("visites")
                    .update({ notifie_arrivee: true })
                    .eq("id", visite_id);
                
                const message = `🩺 ${visite.aidant?.nom || "L'aidant"} est arrivé${distance < 20 ? ' devant le domicile' : ' dans le quartier'} de ${visite.patient.nom_complet}.`;
                
                await sendPushNotification(
                    visite.patient.famille_user_id,
                    "🚪 L'aidant arrive",
                    message,
                    "/#feed"
                );

                await createNotification(
                    visite.patient.famille_user_id,
                    "🚪 L'aidant arrive",
                    `${visite.aidant?.nom || "L'aidant"} est arrivé${distance < 20 ? ' au domicile' : ' dans le quartier'} de ${visite.patient.nom_complet}.`,
                    "visit",
                    "/#feed"
                );
                
                await supabase.from("messages").insert([{
                    patient_id: visite.patient_id,
                    sender_id: req.user.userId,
                    content: `📍 ${visite.aidant?.nom} est arrivé${distance < 20 ? ' au domicile' : ' dans le périmètre'} pour la visite.`,
                    is_photo: false,
                    type_media: 'STORY'
                }]);
                
                console.log(`📢 Notification d'arrivée envoyée pour la visite ${visite_id}`);
            }
        }
        
        res.sendStatus(200);
    } catch (err) { 
        console.error("❌ Erreur tracking:", err.message);
        res.sendStatus(500); 
    }
});

// ============================================================
// 📏 Calcul de distance (Haversine)
// ============================================================
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// ============================================================
// 📡 RADAR LIVE (Coordinateur)
// ============================================================
 router.get("/live-tracking", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        // ✅ Correction : utiliser les bonnes colonnes
        const { data: activeVisits, error } = await supabase
            .from("visites")
            .select(`
                id, 
                aidant_id, 
                alerte_geofence, 
                patient:patients (nom_complet, lat, lng), 
                aidant:profiles!aidant_id (nom)
            `)
            .eq("statut", "En cours");

        if (error) throw error;
        
        if (!activeVisits || activeVisits.length === 0) {
            return res.json([]);
        }

        const liveData = await Promise.all(activeVisits.map(async (v) => {
            const { data: lastPos, error: posError } = await supabase
                .from("positions_live")
                .select("lat, lng")
                .eq("visite_id", v.id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (posError || !lastPos) return null;
            
            return {
                visite_id: v.id,
                lat: lastPos.lat,
                lng: lastPos.lng,
                aidant_nom: v.aidant?.nom || "Aidant",
                patient_nom: v.patient?.nom_complet || "Patient",
                is_inside: !v.alerte_geofence
            };
        }));
        
        res.json(liveData.filter(d => d !== null));
    } catch (e) { 
        console.error("❌ Erreur live-tracking:", e.message);
        res.status(500).json({ error: e.message }); 
    }
});

// ============================================================
// 🏠 POSITION ACTIVE POUR LA FAMILLE
// ============================================================
router.get("/active/:patientId", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { patientId } = req.params;

    try {
        const { data: visite, error: visiteError } = await supabase
            .from("visites")
            .select("id, aidant_id, alerte_geofence")
            .eq("patient_id", patientId)
            .eq("statut", "En cours")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (visiteError || !visite) {
            return res.json({ hasPosition: false });
        }

        const { data: lastPos, error: posError } = await supabase
            .from("positions_live")
            .select("lat, lng, created_at")
            .eq("visite_id", visite.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (posError || !lastPos) {
            return res.json({ hasPosition: false });
        }

        const { data: aidant } = await supabase
            .from("profiles")
            .select("nom, photo_url")
            .eq("id", visite.aidant_id)
            .maybeSingle();   

        res.json({
            hasPosition: true,
            lat: lastPos.lat,
            lng: lastPos.lng,
            last_update: lastPos.created_at,
            aidant_nom: aidant?.nom || "Intervenant",
            aidant_photo: aidant?.photo_url || null,
            is_inside: !visite.alerte_geofence
        });
        
    } catch (err) {
        console.error("❌ Erreur:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// 📍 TRAJECTOIRE D'UNE VISITE
// ============================================================
router.get("/trajectory/:visite_id", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("positions_live")
            .select("lat, lng, created_at")
            .eq("visite_id", req.params.visite_id) 
            .order("created_at", { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// ============================================================
// 📍 POSITION EN DIRECT POUR LA FAMILLE
// ============================================================
router.get("/live-position/:visite_id", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { visite_id } = req.params;
    
    try {
        if (req.user.role === "FAMILLE") {
            const { data: visite } = await supabase
                .from("visites")
                .select("patient:patients(famille_user_id)")
                .eq("id", visite_id)
                .single();
            
            if (!visite?.patient || visite.patient.famille_user_id !== req.user.userId) {
                return res.status(403).json({ error: "Accès non autorisé" });
            }
        }
        
        const { data: lastPos } = await supabase
            .from("positions_live")
            .select("lat, lng, created_at")
            .eq("visite_id", visite_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        
        if (!lastPos) {
            return res.json({ hasPosition: false });
        }
        
        const { data: visite } = await supabase
            .from("visites")
            .select("aidant:profiles!aidant_id(nom, photo_url)")
            .eq("id", visite_id)
            .single();
        
        res.json({
            hasPosition: true,
            lat: lastPos.lat,
            lng: lastPos.lng,
            last_update: lastPos.created_at,
            aidant_nom: visite?.aidant?.nom || "Intervenant",
            aidant_photo: visite?.aidant?.photo_url || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});





// ============================================================
// 📊 1. RÉCUPÉRER TOUS LES AIDANTS ACTIFS (Coordinateur)
// ============================================================
router.get("/active-aidants", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        // Récupérer toutes les visites en cours
        const { data: activeVisits, error } = await supabase
            .from("visites")
            .select(`
                id,
                statut,
                alerte_geofence,
                distance_max_constatee,
                heure_debut,
                patient:patients (
                    id, 
                    nom_complet, 
                    adresse, 
                    lat, 
                    lng,
                    rayon_geofence,
                    statut_validation 
                ),
                aidant:profiles!aidant_id (
                    id, 
                    nom, 
                    email, 
                    telephone, 
                    photo_url
                )
            `)
            .eq("statut", "En cours")
            .order("heure_debut", { ascending: false });

        if (error) throw error;

        // Pour chaque visite, récupérer la dernière position
        const result = await Promise.all((activeVisits || []).map(async (visit) => {
            const { data: lastPos } = await supabase
                .from("positions_live")
                .select("lat, lng, accuracy, created_at")
                .eq("visite_id", visit.id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            // Calculer la distance au patient si les coordonnées existent
            let distanceToPatient = null;
            if (lastPos && visit.patient?.lat && visit.patient?.lng) {
                distanceToPatient = calculateDistance(
                    lastPos.lat, lastPos.lng,
                    visit.patient.lat, visit.patient.lng
                );
            }

            return {
                ...visit,
                last_position: lastPos || null,
                distance_to_patient: distanceToPatient,
                is_inside_geofence: visit.alerte_geofence === false,
                last_update: lastPos?.created_at || null
            };
        }));

        res.json(result);
    } catch (err) {
        console.error("❌ Erreur active-aidants:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 📜 2. HISTORIQUE DES POSITIONS D'UN AIDANT (Coordinateur)
// ============================================================
router.get("/aidant-history/:aidantId", middleware(['COORDINATEUR']), async (req, res) => {
    const { aidantId } = req.params;
    const { date, visite_id } = req.query;
    
    try {
        let query = supabase
            .from("positions_live")
            .select(`
                *,
                visite:visites (
                    id,
                    patient:patients (nom_complet),
                    heure_debut,
                    heure_fin
                )
            `)
            .eq("aidant_id", aidantId);
        
        // Filtrer par visite spécifique ou par date
        if (visite_id) {
            query = query.eq("visite_id", visite_id);
        } else if (date) {
            query = query
                .gte("created_at", `${date}T00:00:00`)
                .lte("created_at", `${date}T23:59:59`);
        }
        
        const { data, error } = await query.order("created_at", { ascending: true });
        
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur aidant-history:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 🚨 3. RÉCUPÉRER TOUTES LES ALERTES GEOFENCE
// ============================================================
router.get("/geofence-alerts", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("visites")
            .select(`
                id,
                alerte_geofence,
                distance_max_constatee,
                created_at,
                patient:patients (
                    id,
                    nom_complet,
                    adresse,
                    lat,
                    lng
                ),
                aidant:profiles!aidant_id (
                    id,
                    nom,
                    telephone
                )
            `)
            .eq("statut", "En cours")
            .eq("alerte_geofence", true)
            .order("created_at", { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur geofence-alerts:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ============================================================
// 📍 4. RÉCUPÉRER TOUS LES DOMICILES PATIENTS
// ============================================================
router.get("/patients-locations", middleware(['COORDINATEUR']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("patients")
            .select(`
                id,
                nom_complet,
                adresse,
                lat,
                lng,
                formule,
                statut_validation,
                famille:famille_user_id (nom, email)
            `)
            .eq("statut_validation", "ACTIF")
            .not("lat", "is", null)
            .not("lng", "is", null);

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur patients-locations:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// 📏 Fonction de calcul de distance (Haversine)
// ============================================================
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}



// backend/routes/notifications.js ou dans visites.js
router.post("/send", middleware(), async (req, res) => {
    const { userId, title, message, type, url } = req.body;
    
    try {
        // Créer la notification dans la base
        await supabase.from("notifications").insert({
            user_id: userId,
            title,
            message,
            type: type || "visit",
            url: url || "/",
            read: false,
            created_at: new Date()
        });
        
        // Envoyer la notification push
        const { sendPushNotification } = require("../utils");
        await sendPushNotification(userId, title, message, url);
        
        res.json({ status: "success" });
    } catch (err) {
        console.error("Erreur envoi notification:", err);
        res.status(500).json({ error: err.message });
    }
});




router.get("/", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
    try {
        let query = supabase.from("visites").select(`
            *,
            patient:patient_id (id, nom_complet, adresse),
            aidant:aidant_id (id, nom, photo_url)
        `);

        if (req.user.role === "AIDANT") {
            query = query.eq("aidant_id", req.user.userId);
        } 
        else if (req.user.role === "FAMILLE") {
            const { data: patients } = await supabase
                .from("patients")
                .select("id")
                .eq("famille_user_id", req.user.userId);
            
            if (!patients || patients.length === 0) {
                return res.json([]);
            }
            
            const patientIds = patients.map(p => p.id);
            
            // ✅ LA FAMILLE VOIT TOUTES LES VISITES (En cours + En attente + Validé)
            query = query.in("patient_id", patientIds);
            // Pas de filtre sur statut → elle voit tout
        }

        const { data, error } = await query.order("heure_debut", { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ROUTE DE TEST REALTIME (accessible à tous les rôles pour le test)
router.post("/test-realtime", middleware(), async (req, res) => {  // ← Enlève ["COORDINATEUR"]
    try {
        console.log("🧪 [TEST] Envoi d'un événement Realtime test...");
        
        const channel = supabase.channel('visites-updates');
        
        await channel.send({
            type: 'broadcast',
            event: 'test_event',
            payload: {
                message: "Ceci est un test",
                timestamp: new Date().toISOString()
            }
        });
        
        console.log("🧪 [TEST] Événement envoyé");
        res.json({ status: "success", message: "Test event sent" });
        
    } catch (err) {
        console.error("❌ Erreur test:", err.message);
        res.status(500).json({ error: err.message });
    }
});


/**
 * 📊 GET - Progression des visites pour une maman
 */
router.get("/progress/:patientId", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { patientId } = req.params;
    
    try {
        // Récupérer toutes les visites du patient
        const { data: visites, error } = await supabase
            .from("visites")
            .select("statut")
            .eq("patient_id", patientId);
        
        if (error) throw error;
        
        const total = visites?.length || 0;
        const completed = visites?.filter(v => v.statut === "Validé").length || 0;
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
        
        res.json({ total, completed, progress });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
