// ranking-routes.js
// Ranking / leaderboard multi-app (via appId) — Kunsi bu Terra, Zero Missões, etc.
// Módulo separado, no mesmo padrão de apk-build-routes.js / apk-decompile-routes.js.
// Requer a tabela ranking_scores (ver ranking-schema.sql).

const express = require('express');
const { Pool } = require('pg');

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function cleanRankNick(s) {
  return String(s || '').trim().slice(0, 18);
}

router.post('/score', async (req, res) => {
  try {
    const appId = String(req.body.appId || '').trim();
    const nickname = cleanRankNick(req.body.nickname);
    const score = Number(req.body.score);
    const level = Number(req.body.level) || 0;

    if (!appId || !nickname || !Number.isFinite(score)) {
      return res.status(400).json({ error: 'appId, nickname e score são obrigatórios' });
    }

    await pool.query(
      `INSERT INTO ranking_scores (app_id, nickname, score, level, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (app_id, nickname)
       DO UPDATE SET
         score = GREATEST(ranking_scores.score, EXCLUDED.score),
         level = CASE WHEN EXCLUDED.score > ranking_scores.score THEN EXCLUDED.level ELSE ranking_scores.level END,
         updated_at = CASE WHEN EXCLUDED.score > ranking_scores.score THEN now() ELSE ranking_scores.updated_at END`,
      [appId, nickname, score, level]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/score error:', err);
    res.status(500).json({ error: 'server_error: ' + (err && err.message ? err.message : String(err)) });
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const appId = String(req.query.appId || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

    if (!appId) return res.status(400).json({ error: 'appId é obrigatório' });

    const { rows } = await pool.query(
      `SELECT nickname AS name, score, level, updated_at AS date
       FROM ranking_scores
       WHERE app_id = $1
       ORDER BY score DESC
       LIMIT $2`,
      [appId, limit]
    );

    res.json({ entries: rows });
  } catch (err) {
    console.error('GET /api/leaderboard error:', err);
    res.status(500).json({ error: 'server_error: ' + (err && err.message ? err.message : String(err)) });
  }
});

module.exports = router;
