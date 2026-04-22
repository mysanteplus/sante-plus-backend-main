const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

/**
 * 📚 GET - Récupérer tous les contenus éducatifs
 */
router.get("/contents", middleware(), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("educational_contents")
            .select("*")
            .eq("is_active", true)
            .order("sort_order", { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur chargement contenus:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * ✅ GET - Récupérer la checklist de naissance d'un patient
 */
router.get("/birth-checklist/:patientId", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { patientId } = req.params;
    
    try {
        // Vérifier que le patient appartient à la famille
        if (req.user.role === "FAMILLE") {
            const { data: patient, error: patientErr } = await supabase
                .from("patients")
                .select("famille_user_id")
                .eq("id", patientId)
                .single();
            
            if (patientErr || patient.famille_user_id !== req.user.userId) {
                return res.status(403).json({ error: "Accès non autorisé" });
            }
        }
        
        const { data, error } = await supabase
            .from("birth_checklists")
            .select("*")
            .eq("patient_id", patientId)
            .order("sort_order", { ascending: true });
        
        if (error) throw error;
        
        // Si pas de checklist, créer la checklist par défaut
        if (!data || data.length === 0) {
            await initializeBirthChecklist(patientId);
            const { data: newData } = await supabase
                .from("birth_checklists")
                .select("*")
                .eq("patient_id", patientId);
            return res.json(newData || []);
        }
        
        res.json(data);
    } catch (err) {
        console.error("❌ Erreur checklist:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * ✅ POST - Mettre à jour un élément de la checklist
 */
router.post("/birth-checklist/update", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { patient_id, item_id, is_checked } = req.body;
    
    if (!patient_id || !item_id) {
        return res.status(400).json({ error: "patient_id et item_id requis" });
    }
    
    try {
        // Vérifier les droits
        if (req.user.role === "FAMILLE") {
            const { data: patient, error: patientErr } = await supabase
                .from("patients")
                .select("famille_user_id")
                .eq("id", patient_id)
                .single();
            
            if (patientErr || patient.famille_user_id !== req.user.userId) {
                return res.status(403).json({ error: "Accès non autorisé" });
            }
        }
        
        const { error } = await supabase
            .from("birth_checklists")
            .update({ 
                is_checked: is_checked,
                updated_at: new Date()
            })
            .eq("id", item_id)
            .eq("patient_id", patient_id);
        
        if (error) throw error;
        
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Erreur mise à jour checklist:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📊 POST - Enregistrer une humeur maman
 */
router.post("/mood", middleware(["FAMILLE"]), async (req, res) => {
    const { patient_id, mood, notes } = req.body;
    
    if (!patient_id || !mood) {
        return res.status(400).json({ error: "patient_id et mood requis" });
    }
    
    try {
        const { error } = await supabase
            .from("mama_moods")
            .insert([{
                patient_id,
                mood,
                notes: notes || null,
                recorded_at: new Date()
            }]);
        
        if (error) throw error;
        
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Erreur sauvegarde humeur:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📊 GET - Récupérer l'historique des humeurs
 */
router.get("/moods/:patientId", middleware(["FAMILLE", "COORDINATEUR"]), async (req, res) => {
    const { patientId } = req.params;
    
    try {
        const { data, error } = await supabase
            .from("mama_moods")
            .select("*")
            .eq("patient_id", patientId)
            .order("recorded_at", { ascending: false })
            .limit(30);
        
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur historique humeurs:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📊 POST - Enregistrer une métrique bébé
 */
router.post("/baby-metric", middleware(["FAMILLE", "AIDANT"]), async (req, res) => {
    const { patient_id, metric_type, value, unit, source } = req.body;
    
    if (!patient_id || !metric_type || value === undefined) {
        return res.status(400).json({ error: "patient_id, metric_type et value requis" });
    }
    
    try {
        const { error } = await supabase
            .from("baby_metrics")
            .insert([{
                patient_id,
                metric_type,
                value,
                unit: unit || null,
                source: source || 'manual',
                recorded_at: new Date()
            }]);
        
        if (error) throw error;
        
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Erreur sauvegarde métrique:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 📊 GET - Récupérer les métriques bébé
 */
router.get("/baby-metrics/:patientId", middleware(["FAMILLE", "COORDINATEUR", "AIDANT"]), async (req, res) => {
    const { patientId } = req.params;
    const { limit = 30 } = req.query;
    
    try {
        const { data, error } = await supabase
            .from("baby_metrics")
            .select("*")
            .eq("patient_id", patientId)
            .order("recorded_at", { ascending: false })
            .limit(parseInt(limit));
        
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur récupération métriques:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 🔧 INITIALISER LA CHECKLIST PAR DÉFAUT POUR UN PATIENT
 */
async function initializeBirthChecklist(patientId) {
    const defaultItems = [
        // Pour Maman
        { category: "maman", item_text: "🩺 Carnet de santé", sort_order: 1 },
        { category: "maman", item_text: "📋 Dossier médical", sort_order: 2 },
        { category: "maman", item_text: "🧦 Vêtements confortables (2-3 tenues)", sort_order: 3 },
        { category: "maman", item_text: "👙 Soutien-gorge d'allaitement", sort_order: 4 },
        { category: "maman", item_text: "🩴 Chaussons / Tongs", sort_order: 5 },
        { category: "maman", item_text: "📱 Chargeur de téléphone", sort_order: 6 },
        { category: "maman", item_text: "💄 Trousse de toilette", sort_order: 7 },
        // Pour Bébé
        { category: "bebe", item_text: "👕 Bodies (4-6)", sort_order: 8 },
        { category: "bebe", item_text: "🧦 Pyjamas (3-4)", sort_order: 9 },
        { category: "bebe", item_text: "🧤 Gants / Bonnet", sort_order: 10 },
        { category: "bebe", item_text: "🧸 Couvertures / Gigoteuse", sort_order: 11 },
        { category: "bebe", item_text: "🍼 Biberons (2-3)", sort_order: 12 },
        { category: "bebe", item_text: "🥛 Lait maternisé (si nécessaire)", sort_order: 13 },
        { category: "bebe", item_text: "🚿 Produits de toilette bébé", sort_order: 14 },
        // Documents
        { category: "documents", item_text: "📄 Carte d'identité", sort_order: 15 },
        { category: "documents", item_text: "💳 Carte de sécurité sociale", sort_order: 16 },
        { category: "documents", item_text: "📊 Résultats d'analyses", sort_order: 17 },
        { category: "documents", item_text: "📝 Échographies", sort_order: 18 }
    ];
    
    const itemsToInsert = defaultItems.map(item => ({
        ...item,
        patient_id: patientId,
        is_checked: false
    }));
    
    const { error } = await supabase
        .from("birth_checklists")
        .insert(itemsToInsert);
    
    if (error) {
        console.error("❌ Erreur initialisation checklist:", error);
    }
}

module.exports = router;
