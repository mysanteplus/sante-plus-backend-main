const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

/**
 * 📋 1. LISTER TOUS LES AIDANTS (Coordinateur uniquement)
 */
router.get("/", middleware(["COORDINATEUR"]), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("role", "AIDANT")
      .order("nom", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📈 2. VOIR LES STATS D'ACTIVITÉ D'UN AIDANT
 * - Coordinateur : peut voir n'importe quel aidant
 * - Aidant : ne peut voir que ses propres stats
 */
router.get("/stats/:id", middleware(["COORDINATEUR", "AIDANT"]), async (req, res) => {
    const aidantId = req.params.id;
    
    // Vérifier que l'aidant ne voit que ses propres stats
    if (req.user.role === "AIDANT" && req.user.userId !== aidantId) {
        return res.status(403).json({ error: "Accès non autorisé à ces statistiques" });
    }
    
    try {
        const { data, error } = await supabase
            .from("visites")
            .select("id, statut")
            .eq("aidant_id", aidantId);

        if (error) throw error;

        const total = data?.length || 0;
        const valides = data?.filter((v) => v.statut === "Validé").length || 0;

        res.json({
            total_visites: total,
            taux_validation: total > 0 ? Math.round((valides / total) * 100) : 0,
        });
    } catch (err) {
        console.error("❌ Erreur stats aidant:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
