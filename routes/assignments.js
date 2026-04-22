const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const { createNotification } = require("./notifications");

/**
 * 📋 1. LISTER LES ASSIGNATIONS
 * - Coordinateur : voit tout
 * - Aidant : voit ses propres assignations actives
 */
router.get("/", middleware(["COORDINATEUR", "AIDANT"]), async (req, res) => {
    try {
        let query = supabase
            .from("planning")
            .select(`
                id,
                patient_id,
                aidant_id,
                date_prevue,
                heure_prevue,
                statut,
                notes_coordinateur,
                est_actif,
                date_fin,
                raison_desactivation,
                patient:patients(id, nom_complet, adresse, formule),
                aidant:profiles!aidant_id(id, nom, email, telephone)
            `)
            .eq("est_actif", true);

        // Filtrer pour l'aidant
        if (req.user.role === "AIDANT") {
            query = query.eq("aidant_id", req.user.userId);
        }

        const { data, error } = await query.order("created_at", { ascending: false });

        if (error) throw error;
        res.json(data || []);

    } catch (err) {
        console.error("❌ Erreur liste assignations:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * ➕ 2. ASSIGNER UN PATIENT À UN AIDANT (Coordinateur uniquement)
 */
router.post("/assign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { 
        patient_id, 
        aidant_id, 
        type_assignation,
        date_debut,
        date_fin,
        heure_prevue,
        notes 
    } = req.body;

    if (!patient_id || !aidant_id) {
        return res.status(400).json({ error: "Patient et aidant requis" });
    }

    try {
        // Vérifier que le patient existe
        const { data: patient, error: patientErr } = await supabase
            .from("patients")
            .select("id, nom_complet, famille_user_id")
            .eq("id", patient_id)
            .single();

        if (patientErr || !patient) {
            return res.status(404).json({ error: "Patient introuvable" });
        }

        // Vérifier que l'aidant existe et a le bon rôle
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();

        if (aidantErr || !aidant) {
            return res.status(404).json({ error: "Aidant introuvable ou rôle incorrect" });
        }

        const assignType = type_assignation || 'permanente';
        
        // Pour les assignations permanentes, vérifier si une existe déjà
        if (assignType === 'permanente') {
            const { data: existing, error: existingErr } = await supabase
                .from("planning")
                .select("id")
                .eq("patient_id", patient_id)
                .eq("aidant_id", aidant_id)
                .eq("est_actif", true)
                .eq("type_assignation", "permanente")
                .maybeSingle();

            if (existing) {
                return res.status(400).json({ error: "Ce patient a déjà un aidant permanent assigné" });
            }
        }

        // Construction des données d'assignation
        const assignData = {
            patient_id,
            aidant_id,
            notes_coordinateur: notes || "",
            type_assignation: assignType,
            est_actif: true,
            date_prevue: date_debut || new Date().toISOString().split('T')[0]
        };

        // ✅ CORRECTION : Ajouter heure_prevue SEULEMENT pour les assignations ponctuelles
        if (assignType === 'ponctuelle') {
            assignData.heure_prevue = heure_prevue || "09:00";
            assignData.statut = "Planifié";
        }
        
        // Ajout des autres champs selon le type
        if (assignType === 'temporelle' && date_fin) {
            assignData.date_fin = date_fin;
        }

        // Créer l'assignation
        const { data: newAssignment, error } = await supabase
            .from("planning")
            .insert([assignData])
            .select()
            .single();

        if (error) {
            console.error("❌ Erreur SQL:", error);
            throw error;
        }

        // Messages personnalisés
        let messageAidant = "";
        let messageFamille = "";
        
        switch(assignType) {
            case 'permanente':
                messageAidant = `Vous êtes maintenant l'aidant permanent de ${patient.nom_complet}.`;
                messageFamille = `${aidant.nom} est maintenant l'aidant permanent de votre proche ${patient.nom_complet}.`;
                break;
            case 'temporelle':
                const finDate = new Date(date_fin).toLocaleDateString('fr-FR');
                messageAidant = `Vous êtes assigné à ${patient.nom_complet} jusqu'au ${finDate}.`;
                messageFamille = `${aidant.nom} accompagne votre proche ${patient.nom_complet} jusqu'au ${finDate}.`;
                break;
            case 'ponctuelle':
                const dateVisite = new Date(date_debut).toLocaleDateString('fr-FR');
                messageAidant = `Visite ponctuelle chez ${patient.nom_complet} le ${dateVisite} à ${heure_prevue || '09:00'}.`;
                messageFamille = `Une visite ponctuelle de ${aidant.nom} est prévue le ${dateVisite} pour ${patient.nom_complet}.`;
                break;
        }

        // Notifications
        sendPushNotification(aidant_id, "📋 Nouvelle assignation", messageAidant, "/#planning");
        await createNotification(aidant_id, "📋 Nouvelle mission", messageAidant, "assignment", "/#planning");

        if (patient.famille_user_id) {
            sendPushNotification(patient.famille_user_id, assignType === 'ponctuelle' ? "📅 Visite programmée" : "👨‍⚕️ Nouvel intervenant", messageFamille, "/#patients");
            await createNotification(patient.famille_user_id, assignType === 'ponctuelle' ? "📅 Visite programmée" : "👨‍⚕️ Nouvel intervenant", messageFamille, "assignment", "/#patients");
        }

        res.json({ 
            status: "success", 
            message: `Assignation créée`,
            assignment: newAssignment
        });

    } catch (err) {
        console.error("❌ Erreur assignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});
/**
 * ❌ 3. DÉLIER UN PATIENT D'UN AIDANT (Coordinateur uniquement)
 */
router.post("/unassign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { assignment_id, raison } = req.body;

    if (!assignment_id) {
        return res.status(400).json({ error: "ID d'assignation requis" });
    }

    try {
        // Récupérer l'assignation avant suppression
        const { data: assignment, error: fetchErr } = await supabase
            .from("planning")
            .select(`
                id,
                patient_id,
                aidant_id,
                patient:patients(id, nom_complet, famille_user_id),
                aidant:profiles!aidant_id(id, nom)
            `)
            .eq("id", assignment_id)
            .single();

        if (fetchErr || !assignment) {
            return res.status(404).json({ error: "Assignation introuvable" });
        }

        // Désactiver l'assignation (soft delete)
        const { error: updateErr } = await supabase
            .from("planning")
            .update({
                est_actif: false,
                date_fin: new Date().toISOString().split('T')[0],
                raison_desactivation: raison || "Désassigné par le coordinateur"
            })
            .eq("id", assignment_id);

        if (updateErr) throw updateErr;

        // 🔔 Notifier l'aidant
        sendPushNotification(
            assignment.aidant_id,
            "❌ Fin d'assignation",
            `Vous n'êtes plus assigné au patient ${assignment.patient.nom_complet}. ${raison ? `Raison: ${raison}` : ''}`,
            "/#planning"
        );

        // 🔔 Notifier la famille
        if (assignment.patient.famille_user_id) {
            sendPushNotification(
                assignment.patient.famille_user_id,
                "👨‍⚕️ Changement d'intervenant",
                `${assignment.aidant.nom} n'est plus assigné à votre proche.`,
                "/#patients"
            );
        }

        res.json({ 
            status: "success", 
            message: `Patient délié de ${assignment.aidant.nom}` 
        });

    } catch (err) {
        console.error("❌ Erreur désassignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 👥 4. LISTER LES AIDANTS DISPONIBLES (Pour assignation)
 */
router.get("/available-aidants", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const { data: aidants, error } = await supabase
            .from("profiles")
            .select("id, nom, email, telephone")
            .eq("role", "AIDANT")
            .eq("statut_validation", "ACTIF")
            .order("nom");

        if (error) throw error;
        res.json(aidants || []);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 👤 5. LISTER LES PATIENTS NON ASSIGNÉS (Pour assignation)
 */
router.get("/unassigned-patients", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        // Récupérer les IDs des patients déjà assignés activement
        const { data: assigned } = await supabase
            .from("planning")
            .select("patient_id")
            .eq("est_actif", true);

        const assignedIds = assigned ? assigned.map(a => a.patient_id) : [];

        let query = supabase
            .from("patients")
            .select("id, nom_complet, adresse, formule")
            .eq("statut_validation", "ACTIF");

        if (assignedIds.length > 0) {
            query = query.not("id", "in", `(${assignedIds.join(",")})`);
        }

        const { data: patients, error } = await query.order("nom_complet");

        if (error) throw error;
        res.json(patients || []);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});





/**
 * 📊 6. TABLEAU DE BORD COMPLET POUR LE COORDINATEUR
 * Retourne : tous les aidants + tous les patients + toutes les assignations
 */
router.get("/full-dashboard", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        // 1. Récupérer tous les aidants actifs
        const { data: aidants, error: aidantsErr } = await supabase
            .from("profiles")
            .select("id, nom, email, telephone, statut_validation")
            .eq("role", "AIDANT")
            .order("nom");

        if (aidantsErr) throw aidantsErr;

        // 2. Récupérer tous les patients actifs
        const { data: patients, error: patientsErr } = await supabase
            .from("patients")
            .select(`
                id, 
                nom_complet, 
                adresse, 
                formule, 
                statut_validation,
                famille:famille_user_id (nom, email)
            `)
            .eq("statut_validation", "ACTIF")
            .order("nom_complet");

        if (patientsErr) throw patientsErr;

        // 3. Récupérer toutes les assignations actives
        const { data: assignments, error: assignmentsErr } = await supabase
            .from("planning")
            .select(`
                id,
                patient_id,
                aidant_id,
                date_prevue,
                statut,
                est_actif,
                notes_coordinateur
            `)
            .eq("est_actif", true);

        if (assignmentsErr) throw assignmentsErr;

        // 4. Construire un mapping patient_id -> aidant_id
        const patientToAidant = {};
        const aidantToPatients = {};

        assignments.forEach(assign => {
            if (assign.est_actif) {
                patientToAidant[assign.patient_id] = assign.aidant_id;
                
                if (!aidantToPatients[assign.aidant_id]) {
                    aidantToPatients[assign.aidant_id] = [];
                }
                aidantToPatients[assign.aidant_id].push({
                    patient_id: assign.patient_id,
                    assignment_id: assign.id,
                    date_prevue: assign.date_prevue,
                    statut: assign.statut,
                    notes: assign.notes_coordinateur
                });
            }
        });

        // 5. Enrichir les aidants avec leurs patients assignés
        const aidantsEnriched = aidants.map(aidant => ({
            ...aidant,
            patients_assignes: aidantToPatients[aidant.id] || [],
            nb_patients: (aidantToPatients[aidant.id] || []).length
        }));

        // 6. Enrichir les patients avec leur aidant assigné
        const patientsEnriched = patients.map(patient => {
            const aidantId = patientToAidant[patient.id];
            const aidant = aidants.find(a => a.id === aidantId);
            return {
                ...patient,
                aidant_assigne: aidant ? {
                    id: aidant.id,
                    nom: aidant.nom,
                    email: aidant.email,
                    telephone: aidant.telephone
                } : null
            };
        });

        res.json({
            aidants: aidantsEnriched,
            patients: patientsEnriched,
            total_aidants: aidants.length,
            total_patients: patients.length,
            total_assignments: assignments.length,
            patients_non_assignes: patientsEnriched.filter(p => !p.aidant_assigne).length
        });

    } catch (err) {
        console.error("❌ Erreur dashboard RH:", err.message);
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
