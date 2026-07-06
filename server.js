require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(length = 8) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return out;
}

function generateLicense() {
  return crypto.randomUUID();
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'medbi-license-server' });
});

app.get('/api/store/apps', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, description, icon, version, size_mb, apk_url FROM apps WHERE published = true ORDER BY name'
    );
    res.json({ apps: rows });
  } catch (err) {
    console.error('store/apps error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/store/generate-code', async (req, res) => {
  const { appId } = req.body || {};
  if (!appId) return res.status(400).json({ error: 'missing_appId' });

  try {
    const appCheck = await pool.query('SELECT id FROM apps WHERE id = $1', [appId]);
    if (appCheck.rowCount === 0) return res.status(404).json({ error: 'unknown_app' });

    let code;
    for (let attempts = 0; attempts < 5; attempts++) {
      code = generateCode();
      const exists = await pool.query('SELECT 1 FROM codes WHERE code = $1', [code]);
      if (exists.rowCount === 0) break;
      code = null;
    }
    if (!code) return res.status(500).json({ error: 'code_generation_failed' });

    await pool.query(
      'INSERT INTO codes (code, app_id) VALUES ($1, $2)',
      [code, appId]
    );
    res.json({ code });
  } catch (err) {
    console.error('generate-code error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/activate', async (req, res) => {
  const { code, deviceId, appId } = req.body || {};
  if (!code || !deviceId || !appId) return res.status(400).json({ error: 'missing_fields' });

  const normalizedCode = String(code).trim().toUpperCase();

  try {
    const { rows } = await pool.query(
      'SELECT * FROM codes WHERE code = $1 AND app_id = $2 AND used = false',
      [normalizedCode, appId]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'invalid_or_used_code' });
    }

    const license = generateLicense();

    await pool.query(
      'UPDATE codes SET used = true, device_id = $1, activated_at = now() WHERE code = $2',
      [deviceId, normalizedCode]
    );
    await pool.query(
      'INSERT INTO licenses (license, code, app_id, device_id) VALUES ($1, $2, $3, $4)',
      [license, normalizedCode, appId, deviceId]
    );

    res.json({ license });
  } catch (err) {
    console.error('activate error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/validate', async (req, res) => {
  const { deviceId, appId, license } = req.body || {};
  if (!deviceId || !appId || !license) return res.json({ valid: false });

  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM licenses WHERE license = $1 AND app_id = $2 AND device_id = $3',
      [license, appId, deviceId]
    );
    res.json({ valid: rows.length > 0 });
  } catch (err) {
    console.error('validate error:', err);
    res.json({ valid: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MEDBI license server escuchando en puerto ${PORT}`));
