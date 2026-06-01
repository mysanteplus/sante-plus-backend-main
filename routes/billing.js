const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");
const { sendPushNotification, getDurationFromPack, calculateSubscriptionEndDate, checkActiveSubscription } = require("../utils");
const { createNotification } = require("./notifications");

// ============================================================
// DÉFINITION DES PACKS
// ============================================================

const PACKS = {
    // Packs médicaux SENIOR (avec patient)
    MEDICAL_SENIOR: {
        ESSENTIEL: { price: 45000, duration: 1, name: "Essentiel", visits: 4 },
        ACCOMPAGNEMENT: { price: 80000, duration: 1, name: "Accompagnement", visits: 8 },
        SERENITE: { price: 100000, duration: 1, name: "Sérénité Seniors", visits: 12 },
        PRIVILEGE: { price: 200000, duration: 1, name: "Privilège Famille", visits: 0 }
    },
    // Packs MAMAN & BÉBÉ (avec patient)
    MEDICAL_MAMAN: {
        ESSENTIEL: { price: 65000, duration: 0.5, name: "Essentiel", weeks: 2 },
        CONFORT: { price: 100000, duration: 0.75, name: "Confort", weeks: 3 },
        SERENITE: { price: 140000, duration: 1, name: "Sérénité", weeks: 4 },
        PRIVILEGE: { price: 200000, duration: 1.25, name: "Privilège", weeks: 5 }
    },
    // Pack Confort 24/7 (sans patient) - inchangé
    CONFORT_247: {
        price: 25000,
        duration: 1,
        name: "Pack Confort 24/7"
    }
};

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
            
            await supabase
                .from("patients")
                .update({
                    statut_paiement: "A jour",
                    date_dernier_paiement: paymentDate.toISOString(),
                    date_fin_abonnement: endDate.toISOString(),
                    duree_abonnement_mois: durationMonths
                })
                .eq("id", patientId);
            
            if (pending?.id) {
                await supabase
                    .from("pending_transactions")
                    .update({ status: "COMPLETED" })
                    .eq("id", pending.id);
            }
            
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
            const { data: profile } = await supabase
                .from("profiles")
                .select("type_compte")
                .eq("id", req.user.userId)
                .single();
            
            const isSansPatient = profile?.type_compte === 'SANS_PATIENT';
            
            if (isSansPatient) {
                query = query.eq("user_id", req.user.userId);
            } else {
                const { data: patient } = await supabase
                    .from("patients")
                    .select("id")
                    .eq("famille_user_id", req.user.userId)
                    .single();
                
                if (!patient) return res.json([]);
                query = query.eq("patient_id", patient.id);
            }
        }

        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("❌ Erreur liste abonnements:", err);
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
    
    if (!process.env.FEDAPAY_SECRET_KEY) {
        console.error("❌ FEDAPAY_SECRET_KEY manquante");
        return res.status(500).json({ error: "Configuration FedaPay manquante" });
    }

    try {
        const { data: patient, error: patientErr } = await supabase
            .from("patients")
            .select("id, nom_complet, formule")
            .eq("id", patient_id)
            .single();
        
        if (patientErr) throw patientErr;
        
        const { data: user, error: userErr } = await supabase
            .from("profiles")
            .select("email, nom")
            .eq("id", req.user.userId)
            .single();
        
        if (userErr) throw userErr;
        
        const fedapayMode = process.env.FEDAPAY_MODE === 'sandbox' ? 'sandbox' : 'production';
        const apiUrl = fedapayMode === 'production' 
            ? "https://api.fedapay.com/v1/transactions"
            : "https://sandbox-api.fedapay.com/v1/transactions";
        
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
            cancel_url: "https://app.mysanteplus.com/#billing?status=cancel",
            metadata: {
                patient_id: patient_id,
                user_id: req.user.userId,
                duration_months: duration_months,
                pack_name: patient.formule || pack_id
            }
        };
        
        const response = await axios.post(apiUrl, requestData, {
            headers: {
                Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}`,
                "Content-Type": "application/json"
            },
            timeout: 30000
        });
        
        if (!response.data || !response.data.payment_url) {
            throw new Error("La réponse de FedaPay ne contient pas d'URL");
        }
        
        await supabase
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
        
        res.json({
            success: true,
            payment_url: response.data.payment_url,
            transaction_id: response.data.id
        });
        
    } catch (err) {
        console.error("❌ FedaPay Error:", err.message);
        
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
        webhook_url: `${process.env.API_URL || 'https://sante-plus-backend-main.onrender.com'}/api/billing/webhook`,
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

// ============================================================
// 💳 7. SOUSCRIRE AU PACK CONFORT 24/7 (comptes SANS_PATIENT)
// ============================================================

router.post("/subscribe-confort", middleware(["FAMILLE"]), async (req, res) => {
    const { montant, duree_mois } = req.body;
    const userId = req.user.userId;
    
    try {
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("type_compte, pack_confort_actif, date_fin_pack_confort")
            .eq("id", userId)
            .single();
        
        if (profileErr) throw profileErr;
        
        if (profile.type_compte !== 'SANS_PATIENT') {
            return res.status(403).json({ error: "Ce pack est réservé aux comptes sans patient" });
        }
        
        const duration = duree_mois || 1;
        const amount = montant || PACKS.CONFORT_247.price * duration;
        
        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + duration);
        endDate.setDate(endDate.getDate() + 5);
        
        const monthYear = startDate.toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" });
        
        const { data: abonnement, error: aboErr } = await supabase
            .from("abonnements")
            .insert([{
                user_id: userId,
                mois_annee: monthYear,
                montant_du: amount,
                montant_paye: amount,
                statut: "Payé",
                type_pack: "CONFORT_247",
                date_paiement: startDate.toISOString(),
                date_fin_abonnement: endDate.toISOString(),
                duree_mois: duration,
                mode_paiement: req.body.mode_paiement || "MANUEL"
            }])
            .select()
            .single();
        
        if (aboErr) throw aboErr;
        
        const { error: updateErr } = await supabase
            .from("profiles")
            .update({
                pack_confort_actif: true,
                date_fin_pack_confort: endDate.toISOString()
            })
            .eq("id", userId);
        
        if (updateErr) throw updateErr;
        
        console.log(`✅ Pack Confort activé pour ${userId} jusqu'au ${endDate.toISOString()}`);
        
        res.json({
            status: "success",
            message: `Pack Confort activé pour ${duration} mois`,
            abonnement_id: abonnement.id,
            date_fin: endDate.toISOString()
        });
        
    } catch (err) {
        console.error("❌ Erreur souscription Pack Confort:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 🔍 8. VÉRIFIER LE STATUT DU PACK CONFORT
// ============================================================

router.get("/confort-status", middleware(["FAMILLE"]), async (req, res) => {
    const userId = req.user.userId;
    
    try {
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("type_compte, pack_confort_actif, date_fin_pack_confort")
            .eq("id", userId)
            .single();
        
        if (profileErr) throw profileErr;
        
        if (profile.type_compte !== 'SANS_PATIENT') {
            return res.json({
                eligible: false,
                actif: false,
                message: "Ce compte n'est pas éligible au Pack Confort"
            });
        }
        
        let isActive = profile.pack_confort_actif === true;
        let daysRemaining = 0;
        
        if (isActive && profile.date_fin_pack_confort) {
            const today = new Date();
            const endDate = new Date(profile.date_fin_pack_confort);
            daysRemaining = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
            
            if (daysRemaining <= 0) {
                isActive = false;
                await supabase
                    .from("profiles")
                    .update({ pack_confort_actif: false })
                    .eq("id", userId);
            }
        }
        
        res.json({
            eligible: true,
            actif: isActive,
            date_fin: profile.date_fin_pack_confort,
            jours_restants: daysRemaining > 0 ? daysRemaining : 0
        });
        
    } catch (err) {
        console.error("❌ Erreur statut Confort:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 🔍 9. VÉRIFIER LE STATUT D'ABONNEMENT (pour frontend)
// ============================================================

router.get("/subscription-status", middleware(["FAMILLE"]), async (req, res) => {
    try {
        const hasSubscription = await checkActiveSubscription(req.user.userId, req.user.role);
        
        let subscriptionInfo = {
            active: hasSubscription,
            type: null,
            endDate: null,
            daysRemaining: 0
        };
        
        if (hasSubscription) {
            const { data: profile } = await supabase
                .from("profiles")
                .select("type_compte, date_fin_pack_confort")
                .eq("id", req.user.userId)
                .single();
            
            if (profile?.type_compte === 'SANS_PATIENT') {
                subscriptionInfo.type = 'CONFORT_247';
                subscriptionInfo.endDate = profile.date_fin_pack_confort;
                if (profile.date_fin_pack_confort) {
                    const daysRemaining = Math.ceil((new Date(profile.date_fin_pack_confort) - new Date()) / (1000 * 60 * 60 * 24));
                    subscriptionInfo.daysRemaining = daysRemaining > 0 ? daysRemaining : 0;
                }
            } else {
                const { data: patient } = await supabase
                    .from("patients")
                    .select("type_pack, date_fin_abonnement")
                    .eq("famille_user_id", req.user.userId)
                    .single();
                
                if (patient) {
                    subscriptionInfo.type = patient.type_pack;
                    subscriptionInfo.endDate = patient.date_fin_abonnement;
                    if (patient.date_fin_abonnement) {
                        const daysRemaining = Math.ceil((new Date(patient.date_fin_abonnement) - new Date()) / (1000 * 60 * 60 * 24));
                        subscriptionInfo.daysRemaining = daysRemaining > 0 ? daysRemaining : 0;
                    }
                }
            }
        }
        
        res.json(subscriptionInfo);
        
    } catch (err) {
        console.error("❌ Erreur subscription-status:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 📄 RÉCUPÉRER UNE FACTURE PAR ID (DOIT ÊTRE EN DERNIER)
// ============================================================

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
        
        const companyInfo = {
            name: "Santé Plus Services",
            logo: "/sante-plus-frontend/assets/images/logo-general-text.png",
            address: "Cotonou, Bénin",
            phone: "+229 01 23 45 67",
            email: "contact@santeplus.bj",
            website: "www.santeplus.bj"
        };
        
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
