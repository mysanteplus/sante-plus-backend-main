const jwt = require("jsonwebtoken");

module.exports = (allowedRoles = []) => {
  return (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Non connecté" });

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded; // Contient { userId, role }

      // Vérification des droits
      if (allowedRoles.length > 0 && !allowedRoles.includes(decoded.role)) {
        return res
          .status(403)
          .json({ error: "Accès interdit : Rôle insuffisant" });
      }
      next();
    } catch (e) {
      res.status(401).json({ error: "Token invalide" });
    }
  };
};
