const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const axios = require("axios");

// Configuration Kikiapay depuis les variables d'environnement
const KIKIAPAY_CONFIG = {
    sandbox: process.env.KIKIAPAY_MODE !== 'production',
    api_key: process.env.KIKIAPAY_API_KEY,
    api_secret: process.env.KIKIAPAY_API_SECRET
};

// ============================================================
// 1. INITIER UN PAIEMENT
// ============================================================
router.post("/init-payment", async (req, res) => {
    const { abonnement_id, montant, patient_nom, user_email } = req.body;

    if (!abonnement_id || !montant) {
        return res.status(400).json({ error: "abonnement_id et montant requis" });
    }

    // Vérifier que la clé API est configurée
    if (!KIKIAPAY_CONFIG.api_key) {
        console.error("❌ KIKIAPAY_API_KEY non configurée");
        return res.status(500).json({ error: "Configuration paiement manquante" });
    }

    try {
        const transaction_id = `SPS_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        const apiUrl = KIKIAPAY_CONFIG.sandbox 
            ? "https://sandbox.kikiapay.net/api/v1/transaction"
            : "https://api.kikiapay.net/api/v1/transaction";

        const response = await axios.post(apiUrl, {
            amount: montant,
            currency: "XOF",
            first_name: patient_nom?.split(' ')[0] || "Client",
            last_name: patient_nom?.split(' ')[1] || "SPS",
            email: user_email || "client@sps.bj",
            phone: "",
            description: `Paiement abonnement Santé Plus`,
            redirect_url: `${process.env.FRONTEND_URL}/#billing?status=success&abonnement_id=${abonnement_id}&montant=${montant}`,
            cancel_url: `${process.env.FRONTEND_URL}/#billing?status=cancel`,
            metadata: {
                transaction_id: transaction_id,
                abonnement_id: abonnement_id
            }
        }, {
            headers: {
                "X-Api-Key": KIKIAPAY_CONFIG.api_key,
                "Content-Type": "application/json"
            }
        });

        console.log("✅ Transaction Kikiapay créée:", response.data);

        res.json({
            success: true,
            payment_url: response.data.payment_url || response.data.redirect_url,
            transaction_id: transaction_id
        });

    } catch (err) {
        console.error("❌ Erreur init paiement:", err.response?.data || err.message);
        res.status(500).json({ 
            error: err.response?.data?.message || "Erreur d'initialisation" 
        });
    }
});

// ============================================================
// 2. CONFIRMATION DE PAIEMENT
// ============================================================
router.get("/confirm", async (req, res) => {
    const { status, abonnement_id, montant, transaction_id } = req.query;

    console.log("🔔 Confirmation paiement reçue:", { status, abonnement_id, montant, transaction_id });

    const frontendUrl = process.env.FRONTEND_URL;

    if (status === "success" && abonnement_id) {
        try {
            const { error: aboErr } = await supabase
                .from("abonnements")
                .update({
                    statut: "Payé",
                    date_paiement: new Date().toISOString(),
                    montant_paye: montant,
                    reference_paiement: transaction_id || `KK_${Date.now()}`,
                    mode_paiement: "KIKIAPAY"
                })
                .eq("id", abonnement_id);

            if (aboErr) throw aboErr;

            const { data: abo } = await supabase
                .from("abonnements")
                .select("patient_id")
                .eq("id", abonnement_id)
                .single();

            if (abo) {
                await supabase
                    .from("patients")
                    .update({
                        statut_paiement: "A jour",
                        date_dernier_paiement: new Date().toISOString()
                    })
                    .eq("id", abo.patient_id);
            }

            console.log(`✅ Paiement validé pour abonnement ${abonnement_id}`);

            res.redirect(`${frontendUrl}/#billing?status=success`);

        } catch (err) {
            console.error("❌ Erreur confirmation:", err.message);
            res.redirect(`${frontendUrl}/#billing?status=error`);
        }
    } else {
        res.redirect(`${frontendUrl}/#billing?status=cancel`);
    }
});

module.exports = router;
