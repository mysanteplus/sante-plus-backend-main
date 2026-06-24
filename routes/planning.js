// routes/planning.js - VERSION COMPLÈTE CORRIGÉE

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { createNotification } = require("./notifications");

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

/**
 * Vérifier si un patient a déjà une assignation active
 */
async function hasActiveAssignment(patientId, excludeId = null) {
    let query = supabase
        .from("planning")
        .select("id, type_assignation")
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
// 1. CRÉER UNE ASSIGNATION (Coordinateur uniquement)
// ============================================================

router.post("/add", middleware(["COORDINATEUR"]), async (req, res) => {
    const { 
        patient_id, 
        aidant_id, 
        type_assignation,
        date_debut,
        date_fin,
        heure_prevue, 
        notes,
        remplace_aidant_id  // NOUVEAU : pour les remplacements temporaires
    } = req.body;

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

        // 2. Vérifier que l'aidant existe
        const { data: aidant, error: aidantErr } = await supabase
            .from("profiles")
            .select("id, nom")
            .eq("id", aidant_id)
            .eq("role", "AIDANT")
            .single();

        if (aidantErr || !aidant) {
            return res.status(404).json({ error: "Aidant introuvable" });
        }

        const assignType = type_assignation || 'permanente';
        
        // 3. Vérifier les assignations existantes
        const existingAssignments = await hasActiveAssignment(patient_id);
        const permanentExists = existingAssignments.some(a => a.type_assignation === 'permanente');
        const tempExists = existingAssignments.some(a => a.type_assignation === 'temporelle');

        // 4. Logique de gestion des assignations
        if (assignType === 'permanente') {
            // Si une assignation permanente existe déjà, on la désactive
            if (permanentExists) {
                const permanent = existingAssignments.find(a => a.type_assignation === 'permanente');
                await desactivateAssignment(permanent.id, "Remplacé par une nouvelle assignation permanente");
            }
            
            // Si une assignation temporelle existe, on la désactive aussi
            if (tempExists) {
                const temp = existingAssignments.find(a => a.type_assignation === 'temporelle');
                await desactivateAssignment(temp.id, "Remplacé par une assignation permanente");
            }
        } else if (assignType === 'temporelle') {
            // Si une assignation permanente existe, on la garde mais on ajoute une temporelle
            // Si une temporelle existe déjà, on la désactive
            if (tempExists) {
                const temp = existingAssignments.find(a => a.type_assignation === 'temporelle');
                await desactivateAssignment(temp.id, "Remplacé par une nouvelle assignation temporelle");
            }
        }

        // 5. Construction des données
        const assignData = {
            patient_id,
            aidant_id,
            notes_coordinateur: notes || "",
            type_assignation: assignType,
            est_actif: true,
            date_prevue: date_debut || new Date().toISOString().split('T')[0]
        };

        if (assignType === 'temporelle' && date_fin) {
            assignData.date_fin = date_fin;
        }
        
        if (assignType === 'ponctuelle') {
            assignData.heure_prevue = heure_prevue || "09:00";
            assignData.statut = "Planifié";
            assignData.date_fin = date_debut; // Une visite ponctuelle n'a qu'une date
        }

        // 6. Créer l'assignation
        const { data: newAssignment, error } = await supabase
            .from("planning")
            .insert([assignData])
            .select()
            .single();

        if (error) throw error;

        // 7. Messages personnalisés
        let messageAidant = "";
        let messageFamille = "";
        let notificationType = "assignment";
        
        switch(assignType) {
            case 'permanente':
                messageAidant = `Vous êtes maintenant l'aidant permanent de ${patient.nom_complet}.`;
                messageFamille = `${aidant.nom} est maintenant l'aidant permanent de votre proche.`;
                break;
            case 'temporelle':
                const finDate = date_fin ? new Date(date_fin).toLocaleDateString('fr-FR') : 'date indéterminée';
                messageAidant = `Vous êtes assigné temporairement à ${patient.nom_complet} jusqu'au ${finDate}.`;
                messageFamille = `${aidant.nom} accompagne temporairement votre proche jusqu'au ${finDate}.`;
                notificationType = "temporary";
                break;
            case 'ponctuelle':
                const dateVisite = new Date(date_debut).toLocaleDateString('fr-FR');
                messageAidant = `Visite ponctuelle chez ${patient.nom_complet} le ${dateVisite} à ${heure_prevue || '09:00'}.`;
                messageFamille = `Une visite ponctuelle est prévue le ${dateVisite} pour votre proche.`;
                notificationType = "visit";
                break;
        }

        // 8. Notifications
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
// 2. LIRE LE PLANNING (Filtré par rôle)
// ============================================================

router.get("/", middleware(["COORDINATEUR", "AIDANT"]), async (req, res) => {
    try {
        let query = supabase.from("planning").select(`
            *,
            patient:patients(id, nom_complet, adresse, famille_user_id),
            aidant:profiles!aidant_id(id, nom, telephone, photo_url)
        `);

        if (req.user.role === "AIDANT") {
            query = query
                .eq("aidant_id", req.user.userId)
                .eq("est_actif", true);
        }

        const { data, error } = await query.order("date_prevue", { ascending: true });

        if (error) throw error;
        res.json(data || []);

    } catch (err) {
        console.error("❌ Erreur lecture planning:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 3. DÉSACTIVER UNE ASSIGNATION (Coordinateur)
// ============================================================

router.post("/desactivate", middleware(["COORDINATEUR"]), async (req, res) => {
    const { assignment_id, raison } = req.body;

    try {
        const assignment = await desactivateAssignment(assignment_id, raison);

        // Notifier l'aidant
        await createNotification(
            assignment.aidant_id,
            "❌ Fin d'assignation",
            `Vous n'êtes plus assigné à ${assignment.patient.nom_complet}. ${raison ? `Raison: ${raison}` : ''}`,
            "assignment",
            "/#planning"
        );

        // Notifier la famille
        if (assignment.patient?.famille_user_id) {
            await createNotification(
                assignment.patient.famille_user_id,
                "👨‍⚕️ Changement d'intervenant",
                `${assignment.aidant?.nom || "L'aidant"} n'est plus assigné à votre proche.`,
                "assignment",
                "/#patients"
            );
        }

        res.json({ 
            status: "success", 
            message: "Assignation désactivée avec succès" 
        });

    } catch (err) {
        console.error("❌ Erreur désactivation:", err.message);
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
            .select("id, patient_id, aidant_id")
            .eq("id", id)
            .single();
        
        if (checkError || !existing) {
            return res.status(404).json({ error: "Assignation introuvable" });
        }
        
        // 2. Mettre à jour les visites liées (planning_id → null)
        const { error: updateVisitesErr } = await supabase
            .from("visites")
            .update({ planning_id: null })
            .eq("planning_id", id);
        
        if (updateVisitesErr) {
            console.error("❌ Erreur mise à jour visites:", updateVisitesErr);
            // On continue quand même, on essaie de supprimer
        }
        
        // 3. Désactiver l'assignation (soft delete au lieu de delete)
        const { error: updateErr } = await supabase
            .from("planning")
            .update({
                est_actif: false,
                date_fin: new Date().toISOString().split('T')[0],
                raison_desactivation: "Supprimé par le coordinateur"
            })
            .eq("id", id);
        
        if (updateErr) {
            console.error("❌ Erreur désactivation:", updateErr);
            return res.status(500).json({ error: updateErr.message });
        }
        
        console.log("✅ Assignation désactivée:", id);
        res.json({ success: true, message: "Assignation désactivée avec succès" });
        
    } catch (err) {
        console.error("❌ Erreur:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 5. LISTER LES ASSIGNATIONS ACTIVES (Coordinateur)
// ============================================================

router.get("/active", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("planning")
            .select(`
                id,
                patient_id,
                aidant_id,
                date_prevue,
                date_fin,
                type_assignation,
                est_actif,
                notes_coordinateur,
                patient:patients(id, nom_complet, adresse, telephone, contact_urgence),
                aidant:profiles!aidant_id(id, nom, telephone, photo_url)
            `)
            .eq("est_actif", true)
            .order("date_prevue", { ascending: true });

        if (error) throw error;
        res.json(data || []);

    } catch (err) {
        console.error("❌ Erreur active:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 6. HISTORIQUE DES ASSIGNATIONS D'UN PATIENT
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
                aidant:profiles!aidant_id(id, nom, telephone)
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
// 7. RÉCUPÉRER LES AIDANTS DISPONIBLES
// ============================================================

router.get("/available-aidants", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        const { data: aidants, error } = await supabase
            .from("profiles")
            .select("id, nom, prenom, email, telephone")
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
// 8. RÉCUPÉRER LES PATIENTS NON ASSIGNÉS
// ============================================================

router.get("/unassigned-patients", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        // Récupérer les IDs des patients avec une assignation active
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
        console.error("❌ Erreur unassigned-patients:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 9. TABLEAU DE BORD COMPLET (Coordinateur)
// ============================================================

router.get("/full-dashboard", middleware(["COORDINATEUR"]), async (req, res) => {
    try {
        // 1. Récupérer tous les aidants actifs
        const { data: aidants, error: aidantsErr } = await supabase
            .from("profiles")
            .select("id, nom, prenom, email, telephone, statut_validation")
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
            type_assignations: {
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
                    telephone: aidant.telephone
                } : null,
                assignation: assignment ? {
                    id: assignment.id,
                    type: assignment.type_assignation,
                    date_fin: assignment.date_fin,
                    statut: assignment.statut
                } : null
            };
        });

        res.json({
            aidants: aidantsEnriched,
            patients: patientsEnriched,
            assignments: assignments,
            total_aidants: aidants.length,
            total_patients: patients.length,
            total_assignments: assignments.length,
            patients_non_assignes: patientsEnriched.filter(p => !p.aidant_assigne).length,
            statistiques: {
                permanentes: assignments.filter(a => a.type_assignation === 'permanente').length,
                temporelles: assignments.filter(a => a.type_assignation === 'temporelle').length,
                ponctuelles: assignments.filter(a => a.type_assignation === 'ponctuelle').length
            }
        });

    } catch (err) {
        console.error("❌ Erreur dashboard RH:", err.message);
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
                aidant:profiles!aidant_id(id, nom, telephone, photo_url)
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

module.exports = router;
