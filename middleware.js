// middleware.js - VERSION CORRIGÉE
const jwt = require("jsonwebtoken");

module.exports = (allowedRoles = []) => {
  return (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Non connecté" });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded; // { userId, role }
      
      // ✅ AJOUTER UN LOG POUR VOIR CE QUI SE PASSE
      console.log(`🔐 [AUTH] Route: ${req.path}, Rôle: ${decoded.role}`);

      // ✅ VÉRIFICATION DES RÔLES AVEC NORMALISATION
      if (allowedRoles.length > 0) {
        // ✅ NORMALISER LE RÔLE (uppercase, trim)
        const userRole = (decoded.role || "").toUpperCase().trim();
        const normalizedAllowed = allowedRoles.map(r => r.toUpperCase().trim());
        
        if (!normalizedAllowed.includes(userRole)) {
          console.warn(`⛔ Accès refusé: ${userRole} n'est pas dans ${normalizedAllowed}`);
          return res.status(403).json({ 
            error: "Accès interdit : Rôle insuffisant",
            required: normalizedAllowed,
            current: userRole
          });
        }
      }
      
      next();
    } catch (e) {
      console.error("❌ Erreur token:", e.message);
      res.status(401).json({ error: "Token invalide" });
    }
  };
};
