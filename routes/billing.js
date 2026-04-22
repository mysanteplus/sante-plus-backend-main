const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification, getDurationFromPack, calculateSubscriptionEndDate } = require("../utils");
const { createNotification } = require("./notifications");

// ============================================================
// 🔐 Vérification signature webhook
// ============================================================
function verifyWebhookSignature(signature, payload) {
  if (!signature || !process.env.FEDAPAY_WEBHOOK_SECRET) return false;
  
  try {
    const parts = signature.split(',');
    let timestamp = null, signatureHash = null;
    
    for (const part of parts) {
      if (part.startsWith('t=')) timestamp = part.substring(2);
      else if (part.startsWith('s=')) signatureHash = part.substring(2);
    }
    
    if (!timestamp || !signatureHash) return false;
    
    const signedPayload = timestamp + "." + payload;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.FEDAPAY_WEBHOOK_SECRET)
      .update(signedPayload)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signatureHash, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch (err) {
    return false;
  }
}

// ============================================================
// 🔔 WEBHOOK FEDAPAY (SANS AUTHENTIFICATION - PLACÉ EN PREMIER)
// ============================================================
router.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("💰 [WEBHOOK] Signal reçu");
  
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (e) {
    event = req.body;
  }
  
  const signature = req.headers['x-fedapay-signature'];
  
  if (!verifyWebhookSignature(signature, JSON.stringify(event))) {
    console.error("❌ [WEBHOOK] Signature invalide");
    return res.status(401).json({ error: "Signature invalide" });
  }
  
  if (event.type === 'transaction.approved' || event.type === 'checkout.completed') {
    const transaction = event.data || event.entity;
    const transactionId = transaction.id;
    const amount = transaction.amount;
    const metadata = transaction.metadata || {};
    
    console.log(`✅ Paiement confirmé: ${transactionId} - ${amount} FCFA`);
    
    try {
      const { data: pending, error: pendingErr } = await supabase
        .from("pending_transactions")
        .select("*")
        .eq("transaction_id", transactionId)
        .single();
      
      const patientId = metadata.patient_id || pending?.patient_id;
      const durationMonths = metadata.duration_months || pending?.duration_months || 1;
      const packName = metadata.pack_name || pending?.pack_name || 'Standard';
      
      if (!patientId) {
        console.error("❌ Pas de patient_id");
        return res.sendStatus(200);
      }
      
      const paymentDate = new Date();
      const endDate = calculateSubscriptionEndDate(paymentDate, durationMonths, 5);
      const monthYear = paymentDate.toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" });
      
      // Créer l'abonnement
      const { error: aboErr } = await supabase
        .from("abonnements")
        .insert([{
          patient_id: patientId,
          mois_annee: monthYear,
          montant_du: amount,
          montant_paye: amount,
          statut: "Payé",
          type_pack: packName,
          date_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          duree_mois: durationMonths,
          reference_paiement: transactionId,
          mode_paiement: "FEDAPAY"
        }]);
      
      if (aboErr) throw aboErr;
      
      // Mettre à jour le patient
      await supabase
        .from("patients")
        .update({ 
          statut_paiement: "A jour",
          date_dernier_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          duree_abonnement_mois: durationMonths
        })
        .eq("id", patientId);
      
      // Mettre à jour la transaction
      if (pending?.id) {
        await supabase
          .from("pending_transactions")
          .update({ status: "COMPLETED" })
          .eq("id", pending.id);
      }
      
      // Notification
      const { data: patient } = await supabase
        .from("patients")
        .select("famille_user_id, nom_complet")
        .eq("id", patientId)
        .single();
      
      if (patient?.famille_user_id) {
        await sendPushNotification(
          patient.famille_user_id,
          "💎 Abonnement activé",
          `Paiement reçu pour ${patient.nom_complet}. Valable ${durationMonths} mois.`,
          "/#dashboard"
        );
      }
      
      console.log(`✅ Abonnement ${durationMonths} mois créé`);
      
    } catch (err) {
      console.error("❌ [WEBHOOK ERROR]:", err.message);
    }
  }
  
  res.sendStatus(200);
});

// ============================================================
// 📊 1. LISTER LES ABONNEMENTS
// ============================================================
router.get("/", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
  try {
    let query = supabase.from("abonnements").select(`
        *,
        patient:patient_id (id, nom_complet, formule, famille_user_id)
    `);

    if (req.user.role === "FAMILLE") {
      const { data: patient } = await supabase
        .from("patients")
        .select("id")
        .eq("famille_user_id", req.user.userId)
        .single();
      
      if (!patient) return res.json([]);
      query = query.eq("patient_id", patient.id);
    }

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ✅ 2. PAIEMENT MANUEL (Coordinateur)
// ============================================================
router.post("/pay", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
  const { abonnement_id, montant, transaction_id, mode_paiement } = req.body;
  try {
    const paymentDate = new Date();
    
    const updateData = {
      montant_paye: montant,
      statut: "Payé",
      date_paiement: paymentDate.toISOString(),
    };
    
    if (transaction_id) updateData.reference_paiement = transaction_id;
    if (mode_paiement) updateData.mode_paiement = mode_paiement;
    
    const { data: abo, error: errAbo } = await supabase
      .from("abonnements")
      .update(updateData)
      .eq("id", abonnement_id)
      .select('*, patient:patients(id, nom_complet, famille_user_id, type_pack)')
      .single();

    if (errAbo) throw errAbo;

    if (abo && abo.patient) {
      const durationMonths = getDurationFromPack(abo.patient.type_pack);
      const endDate = calculateSubscriptionEndDate(paymentDate, durationMonths, 5);
      
      await supabase
        .from("patients")
        .update({ 
          statut_paiement: "A jour",
          date_dernier_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString(),
          duree_abonnement_mois: durationMonths
        })
        .eq("id", abo.patient.id);
      
      await supabase
        .from("abonnements")
        .update({
          date_fin_abonnement: endDate.toISOString(),
          duree_mois: durationMonths
        })
        .eq("id", abonnement_id);

      if (abo.patient.famille_user_id) {
        await sendPushNotification(
          abo.patient.famille_user_id,
          "✅ Paiement validé",
          `Le paiement de ${montant} CFA pour ${abo.patient.nom_complet} a été reçu.`,
          "/#billing"
        );
        
        await createNotification(
          abo.patient.famille_user_id,
          "💳 Paiement reçu",
          `Votre paiement de ${montant} CFA a été confirmé.`,
          "payment",
          "/#billing"
        );
      }
    }

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ Erreur paiement manuel:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 💳 3. INITIER UN PAIEMENT FEDAPAY
// ============================================================
router.post("/initiate-payment", middleware(["FAMILLE"]), async (req, res) => {
  const { pack_id, duration_months, patient_id, amount } = req.body;
  
  console.log("🔵 Initiation paiement:", { pack_id, duration_months, patient_id, amount });
  console.log("🔑 Clé FedaPay présente:", !!process.env.FEDAPAY_SECRET_KEY);
  console.log("🔑 Clé FedaPay (début):", process.env.FEDAPAY_SECRET_KEY?.substring(0, 15) + "...");
  console.log("🌍 Mode configuré:", process.env.FEDAPAY_MODE || 'non défini (par défaut production)');
  
  if (!process.env.FEDAPAY_SECRET_KEY) {
    console.error("❌ FEDAPAY_SECRET_KEY manquante");
    return res.status(500).json({ error: "Configuration FedaPay manquante" });
  }

  try {
    // Récupérer les infos patient
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("id, nom_complet, formule")
      .eq("id", patient_id)
      .single();
    
    if (patientErr) {
      console.error("❌ Erreur patient:", patientErr);
      throw patientErr;
    }
    
    console.log("✅ Patient trouvé:", patient?.nom_complet);
    
    // Récupérer les infos utilisateur
    const { data: user, error: userErr } = await supabase
      .from("profiles")
      .select("email, nom")
      .eq("id", req.user.userId)
      .single();
    
    if (userErr) {
      console.error("❌ Erreur user:", userErr);
      throw userErr;
    }
    
    console.log("✅ Utilisateur trouvé:", user?.email);
    
    // Déterminer l'environnement
    const fedapayMode = process.env.FEDAPAY_MODE === 'sandbox' ? 'sandbox' : 'production';
    const apiUrl = fedapayMode === 'production' 
      ? "https://api.fedapay.com/v1/transactions"
      : "https://sandbox-api.fedapay.com/v1/transactions";
    
    console.log(`🌍 Mode FedaPay: ${fedapayMode}`);
    console.log(`🌍 API URL: ${apiUrl}`);
    
    // Préparer les données pour FedaPay
    const requestData = {
      amount: Math.round(amount),
      currency: "XOF",
      description: `Pack ${patient.formule || pack_id} - ${duration_months} mois`,
      customer: {
        email: user.email,
        firstname: user.nom?.split(' ')[0] || 'Client',
        lastname: user.nom?.split(' ')[1] || 'SPS'
      },
      callback_url: `${process.env.API_URL}/api/billing/webhook`,
      cancel_url: "https://stevenckohr-pixel.github.io/sante-plus-frontend/#billing?status=cancel",
      metadata: {
        patient_id: patient_id,
        user_id: req.user.userId,
        duration_months: duration_months,
        pack_name: patient.formule || pack_id
      }
    };
    
    console.log("📦 Données envoyées à FedaPay:", JSON.stringify(requestData, null, 2));
    
    // Appel à l'API FedaPay
    const response = await axios.post(apiUrl, requestData, {
      headers: { 
        Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    });
    
    console.log("📥 Réponse FedaPay:", response.status, response.statusText);
    
    if (!response.data || !response.data.payment_url) {
      console.error("❌ Réponse FedaPay invalide:", response.data);
      throw new Error("La réponse de FedaPay ne contient pas d'URL");
    }
    
    console.log("✅ Transaction créée, ID:", response.data.id);
    console.log("✅ URL de paiement:", response.data.payment_url);
    
    // Stocker la transaction en attente
    const { error: insertError } = await supabase
      .from("pending_transactions")
      .insert([{
        user_id: req.user.userId,
        patient_id: patient_id,
        transaction_id: response.data.id,
        amount: amount,
        duration_months: duration_months,
        pack_name: patient.formule || pack_id,
        status: "PENDING",
        created_at: new Date()
      }]);
    
    if (insertError) {
      console.error("❌ Erreur insertion pending_transactions:", insertError);
      // Non bloquant, on continue
    }
    
    res.json({ 
      success: true, 
      payment_url: response.data.payment_url,
      transaction_id: response.data.id
    });
    
  } catch (err) {
    console.error("❌ FedaPay Error détaillé:");
    console.error("  - Message:", err.message);
    console.error("  - Status:", err.response?.status);
    console.error("  - Data:", JSON.stringify(err.response?.data, null, 2));
    
    let errorMessage = "Impossible d'initier le paiement";
    if (err.response?.status === 401) {
      errorMessage = "Clé API FedaPay invalide ou manquante";
    } else if (err.response?.status === 400) {
      errorMessage = err.response?.data?.errors?.[0]?.message || "Données de paiement invalides";
    } else if (err.response?.data?.message) {
      errorMessage = err.response.data.message;
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

// ============================================================
// 📝 4. GÉNÉRER UNE FACTURE
// ============================================================
router.post("/generate", middleware(["FAMILLE"]), async (req, res) => {
  const { patient_id, montant, pack } = req.body;
  const monthYear = new Date().toLocaleDateString("fr-FR", {
    month: "2-digit",
    year: "numeric",
  });
  
  const { data, error } = await supabase
    .from("abonnements")
    .insert([{
      patient_id: patient_id,
      mois_annee: monthYear,
      montant_du: montant,
      statut: "En attente",
      type_pack: pack
    }])
    .select()
    .single();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============================================================
// 📊 5. VÉRIFICATION WEBHOOK (Debug)
// ============================================================
router.get("/webhook/status", async (req, res) => {
  res.json({
    status: "active",
    webhook_url: `${process.env.API_URL || 'https://sante-plus-backend-ux1n.onrender.com'}/api/billing/webhook`,
    secret_configured: !!process.env.FEDAPAY_WEBHOOK_SECRET,
    mode: process.env.FEDAPAY_MODE || 'sandbox'
  });
});

// ============================================================
// 📊 6. TRANSACTIONS EN ATTENTE
// ============================================================
router.get("/pending-transactions", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
  try {
    let query = supabase.from("pending_transactions").select("*");
    
    if (req.user.role === "FAMILLE") {
      query = query.eq("user_id", req.user.userId);
    }
    
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



 


// ============================================================
// 🧪 MODE TEST - Paiement simulé (sans FedaPay)
// ============================================================
router.post("/test-payment", middleware(["FAMILLE"]), async (req, res) => {
  const { abonnement_id, montant } = req.body;
  
  console.log("🧪 [TEST] Paiement simulé pour abonnement:", abonnement_id);
  
  try {
    const paymentDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);
    endDate.setDate(endDate.getDate() + 5);
    
    // Mettre à jour l'abonnement
    const { error: aboErr } = await supabase
      .from("abonnements")
      .update({
        statut: "Payé",
        date_paiement: paymentDate.toISOString(),
        montant_paye: montant,
        date_fin_abonnement: endDate.toISOString(),
        mode_paiement: "TEST"
      })
      .eq("id", abonnement_id);
    
    if (aboErr) throw aboErr;
    
    // Récupérer le patient_id
    const { data: abo } = await supabase
      .from("abonnements")
      .select("patient_id")
      .eq("id", abonnement_id)
      .single();
    
    if (abo) {
      // Mettre à jour le patient
      await supabase
        .from("patients")
        .update({
          statut_paiement: "A jour",
          date_dernier_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString()
        })
        .eq("id", abo.patient_id);
    }
    
    console.log("✅ [TEST] Paiement simulé réussi");
    res.json({ success: true, message: "Paiement test réussi" });
    
  } catch (err) {
    console.error("❌ Erreur test payment:", err);
    res.status(500).json({ error: err.message });
  }
});



// ============================================================
// 💳 PAIEMENT POUR LA FAMILLE (test)
// ============================================================
router.post("/family-pay", middleware(["FAMILLE"]), async (req, res) => {
  const { abonnement_id, montant, mode_paiement } = req.body;
  
  console.log("💰 Paiement famille pour abonnement:", abonnement_id);
  
  try {
    const paymentDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);
    endDate.setDate(endDate.getDate() + 5);
    
    const updateData = {
      montant_paye: montant,
      statut: "Payé",
      date_paiement: paymentDate.toISOString(),
      date_fin_abonnement: endDate.toISOString(),
      mode_paiement: mode_paiement || "FAMILLE"
    };
    
    const { data: abo, error: errAbo } = await supabase
      .from("abonnements")
      .update(updateData)
      .eq("id", abonnement_id)
      .select('*, patient:patients(id, nom_complet, famille_user_id)')
      .single();

    if (errAbo) throw errAbo;

    if (abo && abo.patient) {
      await supabase
        .from("patients")
        .update({ 
          statut_paiement: "A jour",
          date_dernier_paiement: paymentDate.toISOString(),
          date_fin_abonnement: endDate.toISOString()
        })
        .eq("id", abo.patient.id);
    }

    res.json({ status: "success" });
    
  } catch (err) {
    console.error("❌ Erreur paiement famille:", err);
    res.status(500).json({ error: err.message });
  }
});



// Récupérer une facture par ID
router.get("/:id", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
    const { id } = req.params;
    
    try {
        const { data, error } = await supabase
            .from("abonnements")
            .select("*")
            .eq("id", id)
            .single();
        
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ============================================================
// 📄 GÉNÉRER UNE FACTURE (détails)
// ============================================================
router.get("/invoice/:id", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
    const { id } = req.params;
    
    try {
        const { data: abonnement, error } = await supabase
            .from("abonnements")
            .select(`
                *,
                patient:patient_id (id, nom_complet, adresse)
            `)
            .eq("id", id)
            .single();
        
        if (error) throw error;
        
        // Formatage des données
        const invoiceData = {
            numero: abonnement.reference_paiement || abonnement.id.substring(0, 8).toUpperCase(),
            date: new Date(abonnement.date_paiement || abonnement.created_at).toLocaleDateString('fr-FR'),
            montant: abonnement.montant_du,
            statut: abonnement.statut,
            type_pack: abonnement.type_pack,
            mois: abonnement.mois_annee,
            patient_nom: abonnement.patient?.nom_complet,
            date_fin: abonnement.date_fin_abonnement ? new Date(abonnement.date_fin_abonnement).toLocaleDateString('fr-FR') : null
        };
        
        res.json(invoiceData);
        
    } catch (err) {
        console.error("❌ Erreur récupération facture:", err);
        res.status(500).json({ error: err.message });
    }
});


// ============================================================
// 📄 RÉCUPÉRER LES DONNÉES D'UNE FACTURE POUR PDF
// ============================================================
router.get("/invoice-data/:id", middleware(["COORDINATEUR", "FAMILLE"]), async (req, res) => {
    const { id } = req.params;
    
    try {
        const { data: abonnement, error } = await supabase
            .from("abonnements")
            .select(`
                *,
                patient:patient_id (
                    id, 
                    nom_complet, 
                    adresse,
                    telephone,
                    formule
                ),
                patient_famille:patient_id (
                    famille_user_id (
                        nom, 
                        email, 
                        telephone,
                        adresse
                    )
                )
            `)
            .eq("id", id)
            .single();
        
        if (error) throw error;
        
        // Récupérer les infos de l'entreprise (depuis une table settings ou en dur)
        const companyInfo = {
            name: "Santé Plus Services",
            logo: "/sante-plus-frontend/assets/images/logo-general-text.png",
            address: "Cotonou, Bénin",
            phone: "+229 01 23 45 67",
            email: "contact@santeplus.bj",
            website: "www.santeplus.bj"
        };
        
        // Formatage
        const invoiceData = {
            numero: abonnement.reference_paiement || abonnement.id.substring(0, 8).toUpperCase(),
            date: new Date(abonnement.date_paiement || abonnement.created_at),
            dateFormatted: new Date(abonnement.date_paiement || abonnement.created_at).toLocaleDateString('fr-FR'),
            montant: abonnement.montant_du,
            montantPaye: abonnement.montant_paye || 0,
            statut: abonnement.statut,
            type_pack: abonnement.type_pack?.replace(/_/g, ' ') || 'Standard',
            mois: abonnement.mois_annee,
            patient_nom: abonnement.patient?.nom_complet,
            patient_adresse: abonnement.patient?.adresse || 'Non renseignée',
            patient_telephone: abonnement.patient?.telephone || 'Non renseigné',
            famille_nom: abonnement.patient?.famille_user_id?.nom,
            famille_email: abonnement.patient?.famille_user_id?.email,
            date_fin: abonnement.date_fin_abonnement ? new Date(abonnement.date_fin_abonnement).toLocaleDateString('fr-FR') : null,
            date_debut: abonnement.date_paiement ? new Date(abonnement.date_paiement).toLocaleDateString('fr-FR') : null,
            company: companyInfo
        };
        
        res.json(invoiceData);
        
    } catch (err) {
        console.error("❌ Erreur récupération facture:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;




