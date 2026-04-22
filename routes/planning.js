const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification } = require("../utils");
const { createNotification } = require("./notifications");

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
    notes 
  } = req.body;

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

    // Vérifier que l'aidant existe
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
    
    // Vérifier les assignations permanentes en double
    if (assignType === 'permanente') {
      const { data: existing } = await supabase
        .from("planning")
        .select("id")
        .eq("patient_id", patient_id)
        .eq("aidant_id", aidant_id)
        .eq("est_actif", true)
        .eq("type_assignation", "permanente")
        .maybeSingle();

      if (existing) {
        return res.status(400).json({ error: "Ce patient a déjà un aidant permanent" });
      }
    }

    // Construction des données
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
    }

    const { data: newAssignment, error } = await supabase
      .from("planning")
      .insert([assignData])
      .select()
      .single();

    if (error) throw error;

    // Messages personnalisés
    let messageAidant = "";
    let messageFamille = "";
    
    switch(assignType) {
      case 'permanente':
        messageAidant = `Vous êtes maintenant l'aidant permanent de ${patient.nom_complet}.`;
        messageFamille = `${aidant.nom} est maintenant l'aidant permanent de votre proche.`;
        break;
      case 'temporelle':
        const finDate = new Date(date_fin).toLocaleDateString('fr-FR');
        messageAidant = `Vous êtes assigné à ${patient.nom_complet} jusqu'au ${finDate}.`;
        messageFamille = `${aidant.nom} accompagne votre proche jusqu'au ${finDate}.`;
        break;
      case 'ponctuelle':
        const dateVisite = new Date(date_debut).toLocaleDateString('fr-FR');
        messageAidant = `Visite ponctuelle chez ${patient.nom_complet} le ${dateVisite}.`;
        messageFamille = `Une visite ponctuelle est prévue le ${dateVisite} pour votre proche.`;
        break;
    }

    // Notifications
    sendPushNotification(aidant_id, "📋 Nouvelle assignation", messageAidant, "/#planning");
    
    if (createNotification) {
      await createNotification(aidant_id, "📋 Nouvelle mission", messageAidant, "assignment", "/#planning");
    }

    if (patient.famille_user_id) {
      sendPushNotification(patient.famille_user_id, "👨‍⚕️ Nouvel intervenant", messageFamille, "/#patients");
      
      if (createNotification) {
        await createNotification(patient.famille_user_id, "👨‍⚕️ Nouvel intervenant", messageFamille, "assignment", "/#patients");
      }
    }

    res.json({ status: "success", assignment: newAssignment });

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
      // L'aidant voit ses assignations actives
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
    const { data: assignment, error: fetchErr } = await supabase
      .from("planning")
      .select("id, patient_id, aidant_id, patient:patients(nom_complet, famille_user_id), aidant:profiles!aidant_id(nom)")
      .eq("id", assignment_id)
      .single();

    if (fetchErr || !assignment) {
      return res.status(404).json({ error: "Assignation non trouvée" });
    }

    const { error } = await supabase
      .from("planning")
      .update({
        est_actif: false,
        date_fin: new Date().toISOString().split('T')[0],
        raison_desactivation: raison || "Désactivé par le coordinateur"
      })
      .eq("id", assignment_id);

    if (error) throw error;

    // Notifier l'aidant
    sendPushNotification(
      assignment.aidant_id,
      "❌ Fin d'assignation",
      `Vous n'êtes plus assigné à ${assignment.patient.nom_complet}.`,
      "/#planning"
    );

    // Notifier la famille
    if (assignment.patient.famille_user_id) {
      sendPushNotification(
        assignment.patient.famille_user_id,
        "👨‍⚕️ Changement d'intervenant",
        `${assignment.aidant.nom} n'est plus assigné à votre proche.`,
        "/#patients"
      );
    }

    res.json({ status: "success" });

  } catch (err) {
    console.error("❌ Erreur désactivation:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4. LISTER LES ASSIGNATIONS ACTIVES (Coordinateur)
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
    res.status(500).json({ error: err.message });
  }
});


/**
 * 🗑️ SUPPRIMER UNE ASSIGNATION (Délier aidant-patient)
 */
router.delete("/:id", middleware(["COORDINATEUR"]), async (req, res) => {
    const { id } = req.params;
    
    console.log("🗑️ Suppression assignation:", id);
    
    if (!id) {
        return res.status(400).json({ error: "ID requis" });
    }
    
    try {
        // Vérifier si l'assignation existe
        const { data: existing, error: checkError } = await supabase
            .from("planning")
            .select("id")
            .eq("id", id)
            .single();
        
        if (checkError || !existing) {
            return res.status(404).json({ error: "Assignation introuvable" });
        }
        
        // Supprimer l'assignation
        const { error: deleteError } = await supabase
            .from("planning")
            .delete()
            .eq("id", id);
        
        if (deleteError) {
            console.error("❌ Erreur suppression:", deleteError);
            return res.status(500).json({ error: deleteError.message });
        }
        
        console.log("✅ Assignation supprimée:", id);
        res.json({ success: true, message: "Assignation supprimée" });
        
    } catch (err) {
        console.error("❌ Erreur:", err);
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
