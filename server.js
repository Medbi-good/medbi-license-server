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

// Promoción "primeros 50 gratis" — activa 1 mes gratis automáticamente,
// sin código, mientras queden cupos (apps.promo_limit / promo_used).
// Después del cupo 50, el dispositivo debe activar con código pago normal.
app.post('/api/store/free-activate', async (req, res) => {
  const { appId, deviceId } = req.body || {};
  if (!appId || !deviceId) return res.status(400).json({ error: 'missing_fields' });

  try {
    // Si este dispositivo ya tiene una licencia (gratis o paga), se la devolvemos
    // en vez de reclamar otro cupo de la promo.
    const existing = await pool.query(
      'SELECT license FROM licenses WHERE app_id = $1 AND device_id = $2 LIMIT 1',
      [appId, deviceId]
    );
    if (existing.rows.length > 0) {
      return res.json({ license: existing.rows[0].license, alreadyActivated: true });
    }

    // Reclama un cupo de forma atómica (evita que dos dispositivos tomen el mismo cupo a la vez)
    const claim = await pool.query(
      `UPDATE apps SET promo_used = COALESCE(promo_used, 0) + 1
       WHERE id = $1 AND promo_limit IS NOT NULL AND COALESCE(promo_used, 0) < promo_limit
       RETURNING promo_used, promo_duration_days`,
      [appId]
    );
    if (claim.rows.length === 0) {
      return res.status(409).json({ error: 'promo_ended' });
    }

    const durationDays = claim.rows[0].promo_duration_days || 30;
    const promoCode = 'PROMO' + generateCode(6);

    await pool.query(
      'INSERT INTO codes (code, app_id, duration_days, used, device_id, activated_at) VALUES ($1, $2, $3, true, $4, now())',
      [promoCode, appId, durationDays, deviceId]
    );

    const license = generateLicense();
    await pool.query(
      "INSERT INTO licenses (license, code, app_id, device_id, expires_at) VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)",
      [license, promoCode, appId, deviceId, durationDays]
    );

    res.json({ license, durationDays, promoSlot: claim.rows[0].promo_used });
  } catch (err) {
    console.error('free-activate error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Consulta cuántos cupos de la promo quedan (para mostrar en MEDBI Store, opcional)
app.get('/api/store/promo-status', async (req, res) => {
  const { appId } = req.query;
  if (!appId) return res.status(400).json({ error: 'missing_appId' });

  try {
    const { rows } = await pool.query(
      'SELECT promo_limit, promo_used FROM apps WHERE id = $1',
      [appId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'unknown_app' });

    const { promo_limit, promo_used } = rows[0];
    if (!promo_limit) return res.json({ active: false });

    const used = promo_used || 0;
    res.json({
      active: used < promo_limit,
      remaining: Math.max(promo_limit - used, 0),
      limit: promo_limit
    });
  } catch (err) {
    console.error('promo-status error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Valida que una licencia siga perteneciendo a ese dispositivo + app
// Además avisa si está por vencer: 7 días antes si es plan anual, 3 días si es mensual
app.post('/api/validate', async (req, res) => {
  const { deviceId, appId, license } = req.body || {};
  if (!deviceId || !appId || !license) return res.json({ valid: false });

  try {
    const { rows } = await pool.query(
      `SELECT l.expires_at, c.duration_days
       FROM licenses l
       JOIN codes c ON c.code = l.code
       WHERE l.license = $1 AND l.app_id = $2 AND l.device_id = $3
         AND (l.expires_at IS NULL OR l.expires_at > now())`,
      [license, appId, deviceId]
    );

    if (rows.length === 0) {
      return res.json({ valid: false });
    }

    const { expires_at, duration_days } = rows[0];
    let daysRemaining = null;
    let warning = false;
    let message = null;

    if (expires_at) {
      const msRemaining = new Date(expires_at).getTime() - Date.now();
      daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));

      // Plan anual (>=300 días) avisa con 7 días de antecedência; mensual con 3 días
      const isAnnual = duration_days >= 300;
      const threshold = isAnnual ? 7 : 3;

      if (daysRemaining <= threshold) {
        warning = true;
        message = daysRemaining <= 0
          ? 'Sua licença vence hoje.'
          : `Sua licença vence em ${daysRemaining} dia${daysRemaining === 1 ? '' : 's'}. Renove para continuar usando o app.`;
      }
    }

    res.json({
      valid: true,
      expiresAt: expires_at,
      daysRemaining,
      warning,
      message
    });
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
