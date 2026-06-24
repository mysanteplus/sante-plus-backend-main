// middleware.js - VERSION CORRIGÉE
const jwt = require("jsonwebtoken");

module.exports = (allowedRoles = []) => {
  return (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ 
        error: "Non connecté",
        code: "UNAUTHORIZED"
      });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded; // { userId, role }
      
      // ✅ LOG POUR VOIR CE QUI SE PASSE
      console.log(`🔐 [AUTH] Route: ${req.path}, Rôle: ${decoded.role}`);

      // ✅ SI AUCUN RÔLE N'EST SPÉCIFIÉ, TOUT LE MONDE A ACCÈS
      if (allowedRoles.length === 0) {
        return next();
      }

      // ✅ NORMALISER LE RÔLE (uppercase, trim)
      const userRole = (decoded.role || "").toUpperCase().trim();
      const normalizedAllowed = allowedRoles.map(r => r.toUpperCase().trim());
      
      // ✅ VÉRIFICATION DES RÔLES
      if (!normalizedAllowed.includes(userRole)) {
        console.warn(`⛔ Accès refusé: ${userRole} n'est pas dans ${normalizedAllowed.join(', ')}`);
        return res.status(403).json({
          error: "Accès interdit : Rôle insuffisant",
          required: normalizedAllowed,
          current: userRole,
          code: "FORBIDDEN"
        });
      }
      
      next();
    } catch (e) {
      console.error("❌ Erreur token:", e.message);
      return res.status(401).json({
        error: "Token invalide ou expiré",
        code: "INVALID_TOKEN"
      });
    }
  };
};
