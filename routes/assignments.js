// routes/assignments.js - VERSION COMPLÈTE CORRIGÉE

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const { createNotification } = require("./notifications");

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

/**
 * Vérifier si un patient a des assignations actives
 */
async function getActiveAssignments(patientId, excludeId = null) {
    let query = supabase
        .from("planning")
        .select("id, type_assignation, aidant_id, date_fin")
        .eq("patient_id", patientId)
        .eq("est_actif", true);
    
    if (excludeId) {
        query = query.neq("id", excludeId);
    }
    
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

/**
 * Désactiver une assignation et gérer les visites liées
 */
async function desactivateAssignment(assignmentId, raison = null) {
    // 1. Récupérer l'assignation
    const { data: assignment, error: fetchErr } = await supabase
        .from("planning")
        .select(`
            id,
            patient_id,
            aidant_id,
            type_assignation,
            patient:patients(nom_complet, famille_user_id),
            aidant:profiles!aidant_id(nom)
        `)
        .eq("id", assignmentId)
        .single();
    
    if (fetchErr || !assignment) {
        throw new Error("Assignation introuvable");
    }
    
    // 2. Mettre à jour les visites liées (planning_id → null)
    const { error: updateVisitesErr } = await supabase
        .from("visites")
        .update({ planning_id: null })
        .eq("planning_id", assignmentId);
    
    if (updateVisitesErr) {
        console.error("❌ Erreur mise à jour visites:", updateVisitesErr);
        // On continue quand même
    }
    
    // 3. Désactiver l'assignation (soft delete)
    const { error: updateErr } = await supabase
        .from("planning")
        .update({
            est_actif: false,
            date_fin: new Date().toISOString().split('T')[0],
            raison_desactivation: raison || "Désactivé par le coordinateur"
        })
        .eq("id", assignmentId);
    
    if (updateErr) throw updateErr;
    
    return assignment;
}

// ============================================================
// 1. LISTER LES ASSIGNATIONS
// ============================================================

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
                type_assignation,
                raison_desactivation,
                patient:patients(id, nom_complet, adresse, formule, famille_user_id),
                aidant:profiles!aidant_id(id, nom, prenom, email, telephone, photo_url)
            `);

        // Filtrer pour l'aidant
        if (req.user.role === "AIDANT") {
            query = query
                .eq("aidant_id", req.user.userId)
                .eq("est_actif", true);
        }

        const { data, error } = await query.order("created_at", { ascending: false });

        if (error) throw error;
        res.json(data || []);

    } catch (err) {
        console.error("❌ Erreur liste assignations:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 2. ASSIGNER UN PATIENT À UN AIDANT (VERSION COMPLÈTE)
// ============================================================

router.post("/assign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { 
        patient_id, 
        aidant_id, 
        type_assignation,
        date_debut,
        date_fin,
        heure_prevue,
        notes,
        remplace_aidant_id  // Pour les remplacements temporaires
    } = req.body;

    if (!patient_id || !aidant_id) {
        return res.status(400).json({ error: "Patient et aidant requis" });
    }

    try {
        // 1. Vérifier que le patient existe
        const { data: patient, error: patientErr } = await supabase
            .from("patients")
            .select("id, nom_complet, famille_user_id")
            .eq("id", patient_id)
            .single();

        if (patientErr || !patient) {
            return res.status(404).json({ error: "Patient introuvable" });
        }

        // 2. Vérifier que l'aidant existe et a le bon rôle
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom, prenom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();

        if (aidantErr || !aidant) {
            return res.status(404).json({ error: "Aidant introuvable ou rôle incorrect" });
        }

        const assignType = type_assignation || 'permanente';
        
        // 3. Récupérer les assignations existantes
        const existingAssignments = await getActiveAssignments(patient_id);
        
        // 4. Vérifier les types d'assignation existants
        const hasPermanent = existingAssignments.some(a => a.type_assignation === 'permanente');
        const hasTemporal = existingAssignments.some(a => a.type_assignation === 'temporelle');
        const hasPonctuel = existingAssignments.some(a => a.type_assignation === 'ponctuelle');

        // 5. Logique de gestion selon le type
        if (assignType === 'permanente') {
            // Si une assignation permanente existe, on la désactive
            if (hasPermanent) {
                const permanent = existingAssignments.find(a => a.type_assignation === 'permanente');
                await desactivateAssignment(permanent.id, "Remplacé par une nouvelle assignation permanente");
            }
            
            // Si une assignation temporelle existe, on la désactive aussi
            if (hasTemporal) {
                const temp = existingAssignments.find(a => a.type_assignation === 'temporelle');
                await desactivateAssignment(temp.id, "Remplacé par une assignation permanente");
            }
            
            // Si une assignation ponctuelle existe, on peut la garder
            // car elle ne concerne qu'une seule visite
        } 
        else if (assignType === 'temporelle') {
            // Si une assignation temporelle existe déjà, on la désactive
            if (hasTemporal) {
                const temp = existingAssignments.find(a => a.type_assignation === 'temporelle');
                await desactivateAssignment(temp.id, "Remplacé par une nouvelle assignation temporelle");
            }
            
            // Si une assignation permanente existe, on garde les deux
            // car la temporelle est prioritaire pendant sa durée
        }
        else if (assignType === 'ponctuelle') {
            // Une assignation ponctuelle peut coexister avec toutes les autres
            // car elle ne concerne qu'une seule date
        }

        // 6. Construction des données d'assignation
        const assignData = {
            patient_id,
            aidant_id,
            notes_coordinateur: notes || "",
            type_assignation: assignType,
            est_actif: true,
            date_prevue: date_debut || new Date().toISOString().split('T')[0]
        };

        // 7. Ajout des champs spécifiques selon le type
        if (assignType === 'ponctuelle') {
            assignData.heure_prevue = heure_prevue || "09:00";
            assignData.statut = "Planifié";
        }
        
        if (assignType === 'temporelle' && date_fin) {
            assignData.date_fin = date_fin;
        }

        // 8. Créer l'assignation
        const { data: newAssignment, error } = await supabase
            .from("planning")
            .insert([assignData])
            .select()
            .single();

        if (error) {
            console.error("❌ Erreur SQL:", error);
            throw error;
        }

        // 9. Messages personnalisés
        let messageAidant = "";
        let messageFamille = "";
        let notificationType = "assignment";
        
        switch(assignType) {
            case 'permanente':
                messageAidant = `Vous êtes maintenant l'aidant permanent de ${patient.nom_complet}.`;
                messageFamille = `${aidant.nom} ${aidant.prenom ? aidant.prenom : ''} est maintenant l'aidant permanent de votre proche ${patient.nom_complet}.`;
                break;
            case 'temporelle':
                const finDate = date_fin ? new Date(date_fin).toLocaleDateString('fr-FR') : 'date indéterminée';
                messageAidant = `Vous êtes assigné temporairement à ${patient.nom_complet} jusqu'au ${finDate}.`;
                messageFamille = `${aidant.nom} ${aidant.prenom ? aidant.prenom : ''} accompagne temporairement votre proche ${patient.nom_complet} jusqu'au ${finDate}.`;
                notificationType = "temporary";
                
                // Si c'est un remplacement, ajouter une info
                if (remplace_aidant_id) {
                    const { data: remplace } = await supabase
                        .from("profiles")
                        .select("nom")
                        .eq("id", remplace_aidant_id)
                        .single();
                    if (remplace) {
                        messageAidant += ` Vous remplacez ${remplace.nom}.`;
                        messageFamille += ` Il/elle remplace ${remplace.nom}.`;
                    }
                }
                break;
            case 'ponctuelle':
                const dateVisite = new Date(date_debut).toLocaleDateString('fr-FR');
                messageAidant = `Visite ponctuelle chez ${patient.nom_complet} le ${dateVisite} à ${heure_prevue || '09:00'}.`;
                messageFamille = `Une visite ponctuelle de ${aidant.nom} est prévue le ${dateVisite} pour ${patient.nom_complet}.`;
                notificationType = "visit";
                break;
        }

        // 10. Notifications
        await createNotification(
            aidant_id,
            "📋 Nouvelle assignation",
            messageAidant,
            notificationType,
            "/#planning"
        );

        if (patient.famille_user_id) {
            await createNotification(
                patient.famille_user_id,
                assignType === 'ponctuelle' ? "📅 Visite programmée" : "👨‍⚕️ Nouvel intervenant",
                messageFamille,
                notificationType,
                "/#patients"
            );
        }

        res.json({ 
            status: "success", 
            message: `Assignation ${assignType} créée avec succès`,
            assignment: newAssignment
        });

    } catch (err) {
        console.error("❌ Erreur assignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 3. DÉLIER UN PATIENT D'UN AIDANT (VERSION COMPLÈTE)
// ============================================================

router.post("/unassign", middleware(["COORDINATEUR"]), async (req, res) => {
    const { assignment_id, raison } = req.body;

    if (!assignment_id) {
        return res.status(400).json({ error: "ID d'assignation requis" });
    }

    try {
        // Récupérer l'assignation avant désactivation
        const { data: assignment, error: fetchErr } = await supabase
            .from("planning")
            .select(`
                id,
                patient_id,
                aidant_id,
                type_assignation,
                patient:patients(id, nom_complet, famille_user_id),
                aidant:profiles!aidant_id(id, nom, prenom)
            `)
            .eq("id", assignment_id)
            .single();

        if (fetchErr || !assignment) {
            return res.status(404).json({ error: "Assignation introuvable" });
        }

        // Désactiver l'assignation avec gestion des visites
        const result = await desactivateAssignment(assignment_id, raison || "Désassigné par le coordinateur");

        // Messages selon le type
        let messageAidant = `Vous n'êtes plus assigné au patient ${assignment.patient.nom_complet}.`;
        let messageFamille = `${assignment.aidant.nom} n'est plus assigné à votre proche.`;
        
        if (raison) {
            messageAidant += ` Raison: ${raison}`;
            messageFamille += ` Raison: ${raison}`;
        }

        if (assignment.type_assignation === 'temporelle') {
            messageAidant = `Votre mission temporaire auprès de ${assignment.patient.nom_complet} est terminée.`;
            messageFamille = `La mission temporaire de ${assignment.aidant.nom} auprès de votre proche est terminée.`;
        }

        // Notifications
        await createNotification(
            assignment.aidant_id,
            "❌ Fin d'assignation",
            messageAidant,
            "assignment",
            "/#planning"
        );

        if (assignment.patient.famille_user_id) {
            await createNotification(
                assignment.patient.famille_user_id,
                "👨‍⚕️ Changement d'intervenant",
                messageFamille,
                "assignment",
                "/#patients"
            );
        }

        res.json({ 
            status: "success", 
            message: `Patient délié de ${assignment.aidant.nom}`,
            assignment: result
        });

    } catch (err) {
        console.error("❌ Erreur désassignation:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 4. SUPPRIMER UNE ASSIGNATION (DELETE - avec gestion des visites)
// ============================================================

router.delete("/:id", middleware(["COORDINATEUR"]), async (req, res) => {
    const { id } = req.params;
    
    console.log("🗑️ Suppression assignation:", id);
    
    if (!id) {
        return res.status(400).json({ error: "ID requis" });
    }
    
    try {
        // 1. Vérifier si l'assignation existe
        const { data: existing, error: checkError } = await supabase
            .from("planning")
            .select("id, patient_id, aidant_id, type_assignation")
            .eq("id", id)
            .single();
        
        if (checkError || !existing) {
            return res.status(404).json({ error: "Assignation introuvable" });
        }
        
        // 2. Désactiver l'assignation (soft delete)
        const result = await desactivateAssignment(id, "Supprimé par le coordinateur");
        
        console.log("✅ Assignation désactivée:", id);
        res.json({ 
            success: true, 
            message: "Assignation désactivée avec succès",
            assignment: result
        });
        
    } catch (err) {
        console.error("❌ Erreur:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 5. LISTER LES AIDANTS DISPONIBLES
// ============================================================

router.get("/available-aidants", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const { data: aidants, error } = await supabase
            .from("profiles")
            .select("id, nom, prenom, email, telephone, photo_url")
            .eq("role", "AIDANT")
            .eq("statut_validation", "ACTIF")
            .order("nom");

        if (error) throw error;
        res.json(aidants || []);

    } catch (err) {
        console.error("❌ Erreur available-aidants:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 6. LISTER LES PATIENTS NON ASSIGNÉS
// ============================================================

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
            .select("id, nom_complet, adresse, formule, categorie_service")
            .eq("statut_validation", "ACTIF");

        if (assignedIds.length > 0) {
            query = query.not("id", "in", `(${assignedIds.join(",")})`);
        }

        const { data: patients, error } = await query.order("nom_complet");

        if (error) throw error;
        res.json(patients || []);

    } catch (err) {
        console.error("❌ Erreur unassigned-patients:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 7. TABLEAU DE BORD COMPLET POUR LE COORDINATEUR
// ============================================================

router.get("/full-dashboard", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        // 1. Récupérer tous les aidants actifs
        const { data: aidants, error: aidantsErr } = await supabase
            .from("profiles")
            .select("id, nom, prenom, email, telephone, statut_validation, photo_url")
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
                categorie_service,
                statut_validation,
                famille:famille_user_id (nom, email, telephone)
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
                date_fin,
                type_assignation,
                statut,
                est_actif,
                notes_coordinateur
            `)
            .eq("est_actif", true);

        if (assignmentsErr) throw assignmentsErr;

        // 4. Construire les mappings
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
                    date_fin: assign.date_fin,
                    type_assignation: assign.type_assignation,
                    statut: assign.statut,
                    notes: assign.notes_coordinateur
                });
            }
        });

        // 5. Enrichir les aidants
        const aidantsEnriched = aidants.map(aidant => ({
            ...aidant,
            patients_assignes: aidantToPatients[aidant.id] || [],
            nb_patients: (aidantToPatients[aidant.id] || []).length,
            statistiques: {
                permanentes: (aidantToPatients[aidant.id] || []).filter(p => p.type_assignation === 'permanente').length,
                temporelles: (aidantToPatients[aidant.id] || []).filter(p => p.type_assignation === 'temporelle').length,
                ponctuelles: (aidantToPatients[aidant.id] || []).filter(p => p.type_assignation === 'ponctuelle').length
            }
        }));

        // 6. Enrichir les patients
        const patientsEnriched = patients.map(patient => {
            const aidantId = patientToAidant[patient.id];
            const aidant = aidants.find(a => a.id === aidantId);
            const assignment = assignments.find(a => a.patient_id === patient.id && a.est_actif);
            return {
                ...patient,
                aidant_assigne: aidant ? {
                    id: aidant.id,
                    nom: aidant.nom,
                    prenom: aidant.prenom,
                    email: aidant.email,
                    telephone: aidant.telephone,
                    photo_url: aidant.photo_url
                } : null,
                assignation: assignment ? {
                    id: assignment.id,
                    type: assignment.type_assignation,
                    date_debut: assignment.date_prevue,
                    date_fin: assignment.date_fin,
                    statut: assignment.statut
                } : null
            };
        });

        // 7. Statistiques globales
        const stats = {
            permanentes: assignments.filter(a => a.type_assignation === 'permanente').length,
            temporelles: assignments.filter(a => a.type_assignation === 'temporelle').length,
            ponctuelles: assignments.filter(a => a.type_assignation === 'ponctuelle').length
        };

        res.json({
            aidants: aidantsEnriched,
            patients: patientsEnriched,
            total_aidants: aidants.length,
            total_patients: patients.length,
            total_assignments: assignments.length,
            patients_non_assignes: patientsEnriched.filter(p => !p.aidant_assigne).length,
            statistiques: stats
        });

    } catch (err) {
        console.error("❌ Erreur dashboard RH:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 8. RÉCUPÉRER L'HISTORIQUE DES ASSIGNATIONS D'UN PATIENT
// ============================================================

router.get("/history/:patientId", middleware(["COORDINATEUR"]), async (req, res) => {
    const { patientId } = req.params;
    const { limit = 50 } = req.query;
    
    try {
        const { data, error } = await supabase
            .from("planning")
            .select(`
                *,
                patient:patients(id, nom_complet),
                aidant:profiles!aidant_id(id, nom, prenom, email, telephone)
            `)
            .eq("patient_id", patientId)
            .order("created_at", { ascending: false })
            .limit(parseInt(limit));

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur history:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 9. RÉCUPÉRER LES ASSIGNATIONS TEMPORAIRES ACTIVES
// ============================================================

router.get("/temporary", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("planning")
            .select(`
                *,
                patient:patients(id, nom_complet, adresse, famille_user_id),
                aidant:profiles!aidant_id(id, nom, prenom, telephone)
            `)
            .eq("type_assignation", "temporelle")
            .eq("est_actif", true)
            .gte("date_fin", new Date().toISOString().split('T')[0])
            .order("date_fin", { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur temporary:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 10. RÉCUPÉRER UNE ASSIGNATION SPÉCIFIQUE
// ============================================================

router.get("/:id", middleware(["COORDINATEUR", "AIDANT"]), async (req, res) => {
    const { id } = req.params;
    
    try {
        let query = supabase
            .from("planning")
            .select(`
                *,
                patient:patients(id, nom_complet, adresse, telephone, famille_user_id),
                aidant:profiles!aidant_id(id, nom, prenom, telephone, photo_url)
            `)
            .eq("id", id);

        // Si c'est un aidant, vérifier qu'il est bien concerné
        if (req.user.role === "AIDANT") {
            query = query.eq("aidant_id", req.user.userId);
        }

        const { data, error } = await query.single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error("❌ Erreur get assignment:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 11. VÉRIFIER LES ASSIGNATIONS EXPIRÉES (CRON)
// ============================================================

router.post("/check-expired", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Récupérer les assignations temporelles expirées
        const { data: expired, error } = await supabase
            .from("planning")
            .select("id, patient_id, aidant_id, patient:patients(nom_complet, famille_user_id), aidant:profiles!aidant_id(nom)")
            .eq("type_assignation", "temporelle")
            .eq("est_actif", true)
            .lt("date_fin", today);

        if (error) throw error;

        let count = 0;
        for (const assignment of expired || []) {
            await desactivateAssignment(assignment.id, "Mission temporaire expirée");
            
            // Notifier l'aidant
            await createNotification(
                assignment.aidant_id,
                "⏰ Fin de mission temporaire",
                `Votre mission temporaire auprès de ${assignment.patient.nom_complet} est terminée.`,
                "assignment",
                "/#planning"
            );
            
            count++;
        }

        res.json({ 
            success: true, 
            message: `${count} assignations temporaires expirées désactivées` 
        });
    } catch (err) {
        console.error("❌ Erreur check-expired:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
