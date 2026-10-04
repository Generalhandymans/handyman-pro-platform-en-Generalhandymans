// Public catalog: trades + scope questionnaires (no prices exposed here).
const express = require('express');
const { ah } = require('../middleware');
const { TRADES, tradeQuestionnaire } = require('../services/estimator');

const router = express.Router();

router.get('/', ah(async (req, res) => {
  res.json(Object.entries(TRADES).map(([service_type, t]) => ({ service_type, label: t.label })));
}));

router.get('/:type', ah(async (req, res) => {
  const q = tradeQuestionnaire(req.params.type);
  if (!q) return res.status(404).json({ error: 'Unknown service type' });
  res.json(q);
}));

module.exports = router;
