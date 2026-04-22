const cron = require("node-cron");
const supabase = require("./supabaseClient");
const { sendPushNotification } = require("./utils");
const { autoAssignPendingCommands } = require("./routes/commandes");

// Auto-assignation des commandes toutes les 5 minutes
cron.schedule("*/5 * * * *", async () => {
    console.log("🤖 [CRON] Vérification des commandes non assignées...");
    await autoAssignPendingCommands();
});

// Importer le module de notifications (après sa création)
let createNotification = null;
try {
    const notificationsModule = require("./routes/notifications");
    createNotification = notificationsModule.createNotification;
} catch (err) {
    console.log("⚠️ Module notifications non chargé (sera chargé plus tard)");
}

/**
 * 📅 CALCULER LA DATE DE FIN D'ABONNEMENT (selon durée)
 */
function calculateSubscriptionEndDate(paymentDate, durationMonths = 1) {
    const endDate = new Date(paymentDate);
    endDate.setMonth(endDate.getMonth() + durationMonths);
    endDate.setDate(endDate.getDate() + 5);
    return endDate;
}

/**
 * 🔒 VÉRIFIER SI L'ABONNEMENT EST VALIDE
 */
function isSubscriptionValid(lastPaymentDate, durationMonths = 1) {
    if (!lastPaymentDate) return false;
    const paymentDate = new Date(lastPaymentDate);
    const endDate = calculateSubscriptionEndDate(paymentDate, durationMonths);
    const today = new Date();
    return today <= endDate;
}

/**
 * 📊 CALCULER LES JOURS RESTANTS
 */
function getDaysRemaining(lastPaymentDate, durationMonths = 1) {
    if (!lastPaymentDate) return 0;
    const paymentDate = new Date(lastPaymentDate);
    const endDate = calculateSubscriptionEndDate(paymentDate, durationMonths);
    const today = new Date();
    const diffTime = endDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : 0;
}

/**
 * 📅 Formater une date
 */
function formatDate(date) {
    if (!date) return 'Date inconnue';
    return new Date(date).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

function startCronJobs() {
  
  /**
   * 1. GÉNÉRATION DES FACTURES (Le 1er du mois à 00h01)
   */
  cron.schedule("1 0 1 * *", async () => {
    console.log("🤖 [FINANCE] Génération des factures mensuelles...");

    const { data: patients, error } = await supabase
      .from("patients")
      .select("id, nom_complet, famille_user_id, montant_prevu, type_pack, duree_abonnement_mois")
      .eq("statut_validation", "ACTIF");

    if (error || !patients) return console.error("❌ Erreur lecture patients pour facturation");

    const monthYear = new Date().toLocaleDateString("fr-FR", {
      month: "2-digit",
      year: "numeric",
    });

    let generatedCount = 0;

    for (const p of patients) {
      const montant = parseInt(p.montant_prevu) || 0;
      if (montant === 0) continue;

      const { data: existingBill } = await supabase
        .from("abonnements")
        .select("id")
        .eq("patient_id", p.id)
        .eq("mois_annee", monthYear)
        .maybeSingle();

      if (existingBill) {
        console.log(`📝 Facture déjà existante pour ${p.nom_complet} - ${monthYear}`);
        continue;
      }

      await supabase.from("abonnements").insert([{
        patient_id: p.id,
        mois_annee: monthYear,
        montant_du: montant,
        statut: "En attente",
        type_pack: p.type_pack
      }]);

      if (p.famille_user_id) {
        sendPushNotification(
          p.famille_user_id,
          "💳 Nouvelle facture disponible",
          `L'abonnement de ${p.nom_complet} pour ${monthYear} (${montant.toLocaleString()} CFA) est disponible.`,
          "/#billing"
        );
      }
      generatedCount++;
    }
    console.log(`✅ ${generatedCount} nouvelles factures générées pour ${monthYear}`);
  });

  /**
   * 2. VÉRIFICATION QUOTIDIENNE DES ABONNEMENTS EXPIRÉS (00h01)
   */
  cron.schedule("1 0 * * *", async () => {
    console.log("🤖 [CRON] Vérification quotidienne des abonnements...");

    const { data: patients, error } = await supabase
      .from("patients")
      .select("id, nom_complet, famille_user_id, date_dernier_paiement, statut_paiement, duree_abonnement_mois, date_fin_abonnement")
      .eq("statut_validation", "ACTIF");

    if (error || !patients) {
      console.error("❌ Erreur récupération patients:", error);
      return;
    }

    let bloques = 0;
    let debloques = 0;
    let rappelsEnvoyes = 0;

    for (const patient of patients) {
      const duration = patient.duree_abonnement_mois || 1;
      const isValid = patient.date_fin_abonnement 
        ? new Date() <= new Date(patient.date_fin_abonnement)
        : isSubscriptionValid(patient.date_dernier_paiement, duration);
      
      const joursRestants = patient.date_fin_abonnement
        ? Math.ceil((new Date(patient.date_fin_abonnement) - new Date()) / (1000 * 60 * 60 * 24))
        : getDaysRemaining(patient.date_dernier_paiement, duration);
      
      const endDate = patient.date_fin_abonnement || 
        (patient.date_dernier_paiement ? calculateSubscriptionEndDate(patient.date_dernier_paiement, duration) : null);

      // 🔒 EXPIRÉ → BLOQUER
      if (!isValid && patient.statut_paiement === "A jour") {
        await supabase
          .from("patients")
          .update({ statut_paiement: "Expiré" })
          .eq("id", patient.id);
        
        bloques++;

        if (patient.famille_user_id) {
          sendPushNotification(
            patient.famille_user_id,
            "🔒 Abonnement expiré",
            `L'abonnement pour ${patient.nom_complet} est expiré depuis le ${formatDate(endDate)}. Renouvelez pour réactiver le suivi.`,
            "/#subscription"
          );
          
          // ✅ Notification dans la base
          if (createNotification) {
            await createNotification(
              patient.famille_user_id,
              "🔒 Abonnement expiré",
              `L'abonnement pour ${patient.nom_complet} est expiré. Veuillez renouveler.`,
              "expiration",
              "/#subscription"
            );
          }
        }
        console.log(`🔒 Patient bloqué: ${patient.nom_complet} (expiré depuis ${formatDate(endDate)})`);
      }

      // ✅ VALIDE → DÉBLOQUER
      else if (isValid && patient.statut_paiement !== "A jour") {
        await supabase
          .from("patients")
          .update({ 
            statut_paiement: "A jour"
          })
          .eq("id", patient.id);
        
        debloques++;

        if (patient.famille_user_id) {
          sendPushNotification(
            patient.famille_user_id,
            "✅ Abonnement réactivé",
            `Votre abonnement pour ${patient.nom_complet} est actif jusqu'au ${formatDate(endDate)}.`,
            "/#dashboard"
          );
        }
        console.log(`✅ Patient réactivé: ${patient.nom_complet} (valable jusqu'au ${formatDate(endDate)})`);
      }

      // ⚠️ RAPPEL SI EXPIRATION DANS MOINS DE 5 JOURS
      else if (isValid && joursRestants <= 5 && joursRestants > 0 && patient.famille_user_id) {
        sendPushNotification(
          patient.famille_user_id,
          "⚠️ Abonnement bientôt expiré",
          `Votre abonnement pour ${patient.nom_complet} expire dans ${joursRestants} jour(s) (le ${formatDate(endDate)}).`,
          "/#subscription"
        );

        // ✅ Notification dans la base
        if (createNotification) {
          await createNotification(
            patient.famille_user_id,
            "⚠️ Abonnement bientôt expiré",
            `Votre abonnement pour ${patient.nom_complet} expire dans ${joursRestants} jour(s) (le ${formatDate(endDate)}).`,
            "expiration",
            "/#subscription"
          );
        }
        rappelsEnvoyes++;
        console.log(`⚠️ Rappel envoyé pour ${patient.nom_complet}: expire dans ${joursRestants} jours`);
      }
    }

    console.log(`📊 [CRON] Résumé: ${bloques} bloqués, ${debloques} réactivés, ${rappelsEnvoyes} rappels envoyés`);
  });

  /**
   * 3. RAPPEL HEBDOMADAIRE POUR LES PRESQUE EXPIRÉS (Lundi à 09h00)
   */
  cron.schedule("0 9 * * 1", async () => {
    console.log("📧 [CRON] Rappel hebdomadaire abonnements...");

    const { data: patients } = await supabase
      .from("patients")
      .select("id, nom_complet, famille_user_id, date_dernier_paiement, date_fin_abonnement, duree_abonnement_mois")
      .eq("statut_validation", "ACTIF")
      .eq("statut_paiement", "A jour");

    if (!patients) return;

    let rappels = 0;

    for (const patient of patients) {
      const duration = patient.duree_abonnement_mois || 1;
      const joursRestants = patient.date_fin_abonnement
        ? Math.ceil((new Date(patient.date_fin_abonnement) - new Date()) / (1000 * 60 * 60 * 24))
        : getDaysRemaining(patient.date_dernier_paiement, duration);
      const endDate = patient.date_fin_abonnement || 
        (patient.date_dernier_paiement ? calculateSubscriptionEndDate(patient.date_dernier_paiement, duration) : null);
      
      if (joursRestants >= 3 && joursRestants <= 10 && patient.famille_user_id) {
        sendPushNotification(
          patient.famille_user_id,
          "📆 Renouvelez votre abonnement",
          `Plus que ${joursRestants} jours avant l'expiration de l'abonnement de ${patient.nom_complet} (le ${formatDate(endDate)}).`,
          "/#subscription"
        );
        
        if (createNotification) {
          await createNotification(
            patient.famille_user_id,
            "📆 Renouvelez votre abonnement",
            `Plus que ${joursRestants} jours avant l'expiration.`,
            "expiration",
            "/#subscription"
          );
        }
        rappels++;
      }
    }

    console.log(`📧 [CRON] ${rappels} rappels hebdomadaires envoyés`);
  });
}

module.exports = startCronJobs;
