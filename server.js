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

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusiones

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

// Catálogo de apps para MEDBI Store
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

// Genera un código de activación de un solo uso para una app
// Middleware: solo tú puedes generar códigos, usando tu clave secreta
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!process.env.ADMIN_SECRET || key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/api/store/generate-code', requireAdmin, async (req, res) => {
  const { appId, plan } = req.body || {};
  if (!appId) return res.status(400).json({ error: 'missing_appId' });

  const durationDays = plan === 'annual' ? 365 : 30;

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
      'INSERT INTO codes (code, app_id, duration_days) VALUES ($1, $2, $3)',
      [code, appId, durationDays]
    );
    res.json({ code, durationDays });
  } catch (err) {
    console.error('generate-code error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Consume un código y ata la licencia a un dispositivo
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
    const durationDays = rows[0].duration_days || 30;

    await pool.query(
      'UPDATE codes SET used = true, device_id = $1, activated_at = now() WHERE code = $2',
      [deviceId, normalizedCode]
    );
    await pool.query(
      'INSERT INTO licenses (license, code, app_id, device_id, expires_at) VALUES ($1, $2, $3, $4, now() + ($5 || \' days\')::interval)',
      [license, normalizedCode, appId, deviceId, durationDays]
    );

    res.json({ license });
  } catch (err) {
    console.error('activate error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Valida que una licencia siga perteneciendo a ese dispositivo + app
app.post('/api/validate', async (req, res) => {
  const { deviceId, appId, license } = req.body || {};
  if (!deviceId || !appId || !license) return res.json({ valid: false });

  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM licenses WHERE license = $1 AND app_id = $2 AND device_id = $3 AND (expires_at IS NULL OR expires_at > now())',
      [license, appId, deviceId]
    );
    res.json({ valid: rows.length > 0 });
  } catch (err) {
    console.error('validate error:', err);
    res.json({ valid: false });
  }
});

app.get('/admin', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MEDBI Admin</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0b1220; color:#fff; margin:0; padding:24px; }
  h1 { font-size:18px; }
  input, select, button { width:100%; padding:14px; margin:8px 0; border-radius:10px; border:1px solid #1e2a44; font-size:15px; box-sizing:border-box; }
  input, select { background:#121b2e; color:#fff; }
  button { background:#2563eb; color:#fff; border:none; font-weight:600; }
  #result { background:#121b2e; border:1px dashed #2563eb; border-radius:10px; padding:16px; margin-top:16px; font-size:22px; text-align:center; letter-spacing:2px; display:none; }
  #err { color:#f87171; font-size:13px; margin-top:8px; }
</style>
</head>
<body>
  <h1>MEDBI — Generar código de activación</h1>
  <input type="password" id="adminKey" placeholder="Tu clave de administrador">
  <select id="appId">
    <option value="guia-guardia">MEDBI Medicina Interna</option>
  </select>
  <select id="plan">
    <option value="monthly">Mensal — 250 FCFA (30 dias)</option>
    <option value="annual">Anual — 2500 FCFA (365 dias)</option>
  </select>
  <button id="genBtn">Generar código</button>
  <div id="result"></div>
  <div id="err"></div>
  <script>
    document.getElementById('genBtn').addEventListener('click', async () => {
      const key = document.getElementById('adminKey').value;
      const appId = document.getElementById('appId').value;
      const plan = document.getElementById('plan').value;
      const err = document.getElementById('err');
      const result = document.getElementById('result');
      err.textContent = ''; result.style.display = 'none';
      try {
        const res = await fetch('/api/store/generate-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify({ appId, plan })
        });
        if (!res.ok) throw new Error(res.status === 401 ? 'Clave incorrecta' : 'Error al generar');
        const data = await res.json();
        result.textContent = data.code;
        result.style.display = 'block';
      } catch (e) {
        err.textContent = e.message;
      }
    });
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MEDBI license server escuchando en puerto ${PORT}`));
