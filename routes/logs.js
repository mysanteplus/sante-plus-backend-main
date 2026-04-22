const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const middleware = require("../middleware");

// Seuls les COORDINATEURS peuvent voir les logs
router.get("/", middleware(["COORDINATEUR"]), async (req, res) => {
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .order("created_at", { ascending: false });
  res.json(data);
});

module.exports = router;
