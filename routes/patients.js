const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

// ============================================================
// 📋 1. LISTER LES PATIENTS
// ============================================================
// backend/routes/patients.js

// 📋 1. LISTER LES PATIENTS (CORRIGÉ)
router.get("/", middleware(["COORDINATEUR", "FAMILLE", "AIDANT"]), async (req, res) => {
  try {
    let query = supabase.from("patients").select(`
        *,
        famille:famille_user_id (nom, email, telephone)
    `);

    // 🔥 CORRECTION POUR LA FAMILLE
    if (req.user.role === "FAMILLE") {
      // Une famille ne voit que SES patients (ceux liés à son ID)
      query = query.eq("famille_user_id", req.user.userId);
    } 
    else if (req.user.role === "AIDANT") {
      // Un aidant voit les patients qui lui sont assignés
      const { data: planning } = await supabase
        .from("planning")
        .select("patient_id")
        .eq("aidant_id", req.user.userId)
        .eq("est_actif", true);
      
      const patientIds = planning ? planning.map(p => p.patient_id) : [];
      
      if (patientIds.length === 0) {
        return res.json([]);
      }
      query = query.in("id", patientIds);
    }
    // COORDINATEUR voit tout (pas de filtre)

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("❌ Erreur Route Patients:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ➕ 2. AJOUTER UN PATIENT
// ============================================================
router.post("/add", middleware(["COORDINATEUR"]), async (req, res) => {
    const { nom_complet, prenom, nom, age, sexe, telephone, adresse, contact_urgence, formule } = req.body;

    const { data, error } = await supabase.from("patients").insert([
        {
            nom_complet,
            prenom,
            nom,
            age,
            sexe,
            telephone,
            adresse,
            contact_urgence,
            formule,
            coordinateur_id: req.user.userId,
            statut_validation: 'ACTIF'  
        },
    ]);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});
// ============================================================
// 🔗 3. LIER UNE FAMILLE À UN PATIENT
// ============================================================
router.post("/link-family", middleware(["COORDINATEUR"]), async (req, res) => {
  const { patient_id, famille_user_id } = req.body;

  const { error } = await supabase
    .from("patients")
    .update({ famille_user_id: famille_user_id })
    .eq("id", patient_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});

// ============================================================
// 🔍 4. RÉCUPÉRER UN PATIENT
// ============================================================
router.get("/:id", middleware(["COORDINATEUR", "AIDANT", "FAMILLE"]), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("patients")
      .select(`
        *,
        famille:famille_user_id (nom, email, telephone)
      `)
      .eq("id", req.params.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: "Dossier introuvable" });
  }
});

// ============================================================
// 📍 5. FIXER LES COORDONNÉES GPS
// ============================================================
router.post("/update-gps", middleware(['COORDINATEUR', 'AIDANT']), async (req, res) => {
  const { patient_id, lat, lng } = req.body;

  try {
    const { error } = await supabase
      .from("patients")
      .update({ 
        lat: lat, 
        lng: lng,
        rayon_geofence: 100
      })
      .eq("id", patient_id);

    if (error) throw error;
    res.json({ status: "success", message: "Coordonnées du domicile enregistrées." });
  } catch (err) {
    console.error("❌ Erreur Update GPS:", err.message);
    res.status(500).json({ error: "Impossible d'enregistrer la position." });
  }
});

// ============================================================
// 💳 6. METTRE À JOUR LE PACK D'UN PATIENT
// ============================================================
router.put("/:id/update-pack", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
  const { id } = req.params;
  const { type_pack, montant_prevu, duree_abonnement_mois } = req.body;
  
  if (req.user.role === "FAMILLE") {
    const { data: patient } = await supabase
      .from("patients")
      .select("famille_user_id")
      .eq("id", id)
      .single();
    
    if (!patient || patient.famille_user_id !== req.user.userId) {
      return res.status(403).json({ error: "Accès non autorisé" });
    }
  }
  
  // ✅ Construire l'objet de mise à jour uniquement avec les colonnes qui existent
  const updateData = {};
  if (type_pack !== undefined) updateData.type_pack = type_pack;
  if (montant_prevu !== undefined) updateData.montant_prevu = montant_prevu;
  if (duree_abonnement_mois !== undefined) updateData.duree_abonnement_mois = duree_abonnement_mois;
  
  console.log("📝 Mise à jour pack:", updateData);
  
  const { error } = await supabase
    .from("patients")
    .update(updateData)
    .eq("id", id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});

// ============================================================
// ✏️ 7. METTRE À JOUR LES INFOS PATIENT
// ============================================================
router.put("/update-info", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
  const { adresse, notes_medicales } = req.body;
  
  let patientId = req.body.patient_id;
  
  if (req.user.role === "FAMILLE" && !patientId) {
    const { data: patient } = await supabase
      .from("patients")
      .select("id")
      .eq("famille_user_id", req.user.userId)
      .single();
    patientId = patient?.id;
  }
  
  if (!patientId) return res.status(404).json({ error: "Patient non trouvé" });
  
  const { error } = await supabase
    .from("patients")
    .update({ adresse, notes_medicales })
    .eq("id", patientId);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "success" });
});

// ============================================================
// 📸 8. METTRE À JOUR LA PHOTO DU PATIENT
// ============================================================
router.post("/update-photo", middleware(["FAMILLE", "COORDINATEUR"]), upload.single('photo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Aucune photo" });
    
    let patientId = req.body.patient_id;
    
    if (req.user.role === "FAMILLE" && !patientId) {
      const { data: patient } = await supabase
        .from("patients")
        .select("id")
        .eq("famille_user_id", req.user.userId)
        .single();
      patientId = patient?.id;
    }
    
    if (!patientId) return res.status(404).json({ error: "Patient non trouvé" });
    
    const fileName = `patients/${patientId}_${Date.now()}.jpg`;
    await supabase.storage.from("photos").upload(fileName, file.buffer, {
      contentType: 'image/jpeg',
      upsert: true
    });
    
    const { data: urlData } = supabase.storage.from("photos").getPublicUrl(fileName);
    const photo_url = urlData.publicUrl;
    
    await supabase.from("patients").update({ photo_url }).eq("id", patientId);
    
    res.json({ photo_url });
  } catch (err) {
    console.error("❌ Erreur update-photo:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✏️ Mettre à jour toutes les infos du patient (complet)
 */
router.put("/update-full-info", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { 
        prenom, 
        nom, 
        age, 
        sexe, 
        telephone, 
        adresse, 
        contact_urgence, 
        traitements, 
        allergies,
        notes_medicales 
    } = req.body;
    
    let patientId = req.body.patient_id;
    
    if (req.user.role === "FAMILLE" && !patientId) {
        const { data: patient } = await supabase
            .from("patients")
            .select("id")
            .eq("famille_user_id", req.user.userId)
            .single();
        patientId = patient?.id;
    }
    
    if (!patientId) return res.status(404).json({ error: "Patient non trouvé" });
    
    const nomComplet = `${prenom || ''} ${nom || ''}`.trim();
    
    const { error } = await supabase
        .from("patients")
        .update({ 
            prenom, 
            nom, 
            nom_complet: nomComplet,
            age, 
            sexe, 
            telephone, 
            adresse, 
            contact_urgence, 
            traitements, 
            allergies,
            notes_medicales
        })
        .eq("id", patientId);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "success" });
});



// ============================================================
// ➕ AJOUTER UN PATIENT APRÈS INSCRIPTION (compte SANS_PATIENT)
// ============================================================
router.post("/add-after-registration", middleware(["FAMILLE"]), async (req, res) => {
    const { 
        nom_complet, 
        prenom, 
        nom, 
        age, 
        sexe, 
        adresse, 
        telephone, 
        contact_urgence, 
        notes_medicales 
    } = req.body;
    
    const userId = req.user.userId;
    
    if (!nom_complet || !adresse) {
        return res.status(400).json({ error: "Nom complet et adresse sont requis" });
    }
    
    try {
        // 1. Vérifier que l'utilisateur est bien un compte SANS_PATIENT
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("type_compte, role")
            .eq("id", userId)
            .single();
        
        if (profileErr) throw profileErr;
        
        if (profile.role !== "FAMILLE") {
            return res.status(403).json({ error: "Seuls les comptes famille peuvent ajouter un patient" });
        }
        
        if (profile.type_compte !== "SANS_PATIENT") {
            return res.status(403).json({ error: "Ce compte a déjà un patient associé" });
        }
        
        // 2. Vérifier que l'utilisateur n'a pas déjà un patient
        const { data: existingPatient, error: checkErr } = await supabase
            .from("patients")
            .select("id")
            .eq("famille_user_id", userId)
            .maybeSingle();
        
        if (existingPatient) {
            return res.status(400).json({ error: "Vous avez déjà un patient associé à votre compte" });
        }
        
        // 3. Créer le patient
        const patientData = {
            nom_complet: nom_complet,
            prenom: prenom || null,
            nom: nom || null,
            age: age ? parseInt(age) : null,
            sexe: sexe || null,
            adresse: adresse,
            telephone: telephone || null,
            contact_urgence: contact_urgence || null,
            notes_medicales: notes_medicales || null,
            formule: "PONCTUEL",  // Formule par défaut
            famille_user_id: userId,
            statut_paiement: 'A jour', 
            statut_validation: 'ACTIF',
            categorie_service: req.body.categorie || 'SENIOR',
            a_ete_ajoute_apres: true  // ← Flag pour savoir que le patient a été ajouté après
        };
        
        const { data: newPatient, error: patientErr } = await supabase
            .from("patients")
            .insert([patientData])
            .select()
            .single();
        
        if (patientErr) throw patientErr;
        
        // 4. Mettre à jour le type de compte de l'utilisateur
        const { error: updateErr } = await supabase
            .from("profiles")
            .update({ 
                type_compte: "AVEC_PATIENT",
                updated_at: new Date()
            })
            .eq("id", userId);
        
        if (updateErr) throw updateErr;
        
        console.log(`✅ Patient ajouté après inscription pour l'utilisateur ${userId}`);
        
        res.json({ 
            status: "success", 
            message: "Patient ajouté avec succès. Votre compte a été transformé en compte avec patient.",
            patient: newPatient
        });
        
    } catch (err) {
        console.error("❌ Erreur ajout patient après inscription:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
