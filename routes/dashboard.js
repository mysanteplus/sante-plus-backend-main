const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

router.get("/stats", middleware(["COORDINATEUR"]), async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    // On lance toutes les requêtes en parallèle
    const [patients, visitesToday, visitesPending, billingStats] = await Promise.all([
      // 1. Nombre de dossiers actifs
      supabase.from("patients").select("*", { count: "exact", head: true }).eq("statut", "ACTIF"),

      // 2. Visites du jour
      supabase.from("visites").select("*", { count: "exact", head: true }).gte("heure_debut", `${today}T00:00:00`),

      // 3. Alertes (Visites hors zone ou en attente)
      supabase.from("visites").select("*", { count: "exact", head: true }).eq("statut", "En attente"),

      // 4. CALCUL DU CA (Chiffre d'Affaires)
      supabase.from("abonnements").select("montant_paye, statut")
    ]);

    // Calcul du CA Total et des Impayés
    let caTotal = 0;
    let impayesCount = 0;
    
    if (billingStats.data) {
        billingStats.data.forEach(b => {
            caTotal += (b.montant_paye || 0);
            if (b.statut === "En retard") impayesCount++;
        });
    }

    res.json({
      total_patients: patients.count || 0,
      visits_today: visitesToday.count || 0,
      pending_validation: visitesPending.count || 0,
      late_payments: impayesCount,
      revenue_total: caTotal
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
