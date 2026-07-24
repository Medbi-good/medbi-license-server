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

// NOTA: esta constante já não é usada na lógica de /free-activate.
// Cada app tem agora a sua própria data em apps.free_until (editável no /admin),
// que é o que controla até quando essa app específica é gratuita.
// Mantida aqui apenas por referência/histórico.
const PROMO_HARD_CUTOFF = process.env.PROMO_HARD_CUTOFF || '2027-05-31T23:59:59Z';

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
      'SELECT id, name, description, icon, version, size_mb, apk_url, is_free, free_until FROM apps WHERE published = true ORDER BY name'
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

// Activación gratis automática, sin código. Orden de prioridad por app,
// según los campos configurados en /admin (tabla `apps`):
//   1. is_free = true y sin free_until → gratis para siempre, sin expiración.
//   2. free_until definido y aún no ha pasado → gratis hasta esa fecha exacta
//      (cada app puede tener su propia fecha, ej. Biologia 2027, MEDBI 2026).
//   3. Si no aplica ninguna de las anteriores → esquema clásico de cupos
//      (promo_limit / promo_used / promo_duration_days), como el "primeros
//      1000 gratis, 7 días" de MEDBI Medicina Interna.
// Si no hay cupo disponible en el punto 3, se exige código pago normal.
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

    const appRow = await pool.query(
      'SELECT is_free, free_until, promo_limit, promo_used, promo_duration_days FROM apps WHERE id = $1',
      [appId]
    );
    if (appRow.rowCount === 0) return res.status(404).json({ error: 'unknown_app' });

    const { is_free, free_until, promo_limit, promo_duration_days } = appRow.rows[0];

    // "É uma app gratuita (para sempre)" no /admin: sem expiración, sin código.
    if (is_free && !free_until) {
      const license = generateLicense();
      const promoCode = 'FREEAPP' + generateCode(6);
      await pool.query(
        'INSERT INTO codes (code, app_id, duration_days, used, device_id, activated_at) VALUES ($1, $2, NULL, true, $3, now())',
        [promoCode, appId, deviceId]
      );
      await pool.query(
        'INSERT INTO licenses (license, code, app_id, device_id, expires_at) VALUES ($1, $2, $3, $4, NULL)',
        [license, promoCode, appId, deviceId]
      );
      return res.json({ license, alwaysFree: true });
    }

    // "Grátis até" (free_until) de cada app: mientras no se haya pasado esa fecha,
    // se activa gratis automáticamente sin necesitar promo_limit configurado.
    const freeUntilActive = free_until && Date.now() < new Date(free_until).getTime();

    if (freeUntilActive) {
      const license = generateLicense();
      const promoCode = 'PROMO' + generateCode(6);
      await pool.query(
        'INSERT INTO codes (code, app_id, duration_days, used, device_id, activated_at) VALUES ($1, $2, NULL, true, $3, now())',
        [promoCode, appId, deviceId]
      );
      // Expira exactamente en free_until de esa app (no un cutoff global).
      await pool.query(
        'INSERT INTO licenses (license, code, app_id, device_id, expires_at) VALUES ($1, $2, $3, $4, $5::timestamptz)',
        [license, promoCode, appId, deviceId, free_until]
      );
      return res.json({ license, freeUntil: free_until });
    }

    // Ni "gratis para siempre" ni dentro de "grátis até": cae al esquema clásico
    // de cupos (promo_limit / promo_duration_days), si está configurado.
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
      'INSERT INTO licenses (license, code, app_id, device_id, expires_at) VALUES ($1, $2, $3, $4, now() + ($5 || \' days\')::interval)',
      [license, promoCode, appId, deviceId, durationDays]
    );

    res.json({ license, durationDays, promoSlot: claim.rows[0].promo_used });
  } catch (err) {
    console.error('free-activate error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Consulta el estado de la promo gratis de una app (para mostrar en MEDBI Store, opcional)
app.get('/api/store/promo-status', async (req, res) => {
  const { appId } = req.query;
  if (!appId) return res.status(400).json({ error: 'missing_appId' });

  try {
    const { rows } = await pool.query(
      'SELECT is_free, free_until, promo_limit, promo_used FROM apps WHERE id = $1',
      [appId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'unknown_app' });

    const { is_free, free_until, promo_limit, promo_used } = rows[0];

    if (is_free && !free_until) {
      return res.json({ active: true, alwaysFree: true });
    }

    if (free_until) {
      const active = Date.now() < new Date(free_until).getTime();
      return res.json({ active, freeUntil: free_until });
    }

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

// Atualiza a data "grátis até" de uma app — de uma só vez, para
// (1) apps.free_until, que controla novas ativações a partir de agora, e
// (2) todas as licenças grátis (PROMO*/FREEAPP*) já emitidas para essa app,
// que é o que faz a mudança chegar a quem já descarregou.
// Se passares deviceId, só atualiza a licença desse dispositivo específico.
app.post('/api/store/update-license-expiry', requireAdmin, async (req, res) => {
  const { appId, freeUntil, deviceId } = req.body || {};
  if (!appId || !freeUntil) return res.status(400).json({ error: 'missing_fields' });

  try {
    const appCheck = await pool.query('SELECT id FROM apps WHERE id = $1', [appId]);
    if (appCheck.rowCount === 0) return res.status(404).json({ error: 'unknown_app' });

    // 1) Atualiza a data oficial da app (afeta quem ainda vai ativar)
    await pool.query(
      'UPDATE apps SET free_until = $1::timestamptz WHERE id = $2',
      [freeUntil, appId]
    );

    // 2) Atualiza as licenças grátis já emitidas (afeta quem já descarregou)
    const params = [freeUntil, appId];
    let query = `
      UPDATE licenses l
      SET expires_at = $1::timestamptz
      FROM codes c
      WHERE l.code = c.code
        AND l.app_id = $2
        AND (c.code LIKE 'PROMO%' OR c.code LIKE 'FREEAPP%')
    `;
    if (deviceId) {
      query += ' AND l.device_id = $3';
      params.push(deviceId);
    }
    query += ' RETURNING l.device_id, l.expires_at';

    const { rows } = await pool.query(query, params);

    res.json({
      ok: true,
      appFreeUntilUpdated: freeUntil,
      licensesUpdated: rows.length,
      licenses: rows
    });
  } catch (err) {
    console.error('update-license-expiry error:', err);
    res.status(500).json({ error: 'server_error' });
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
  #expiryResult { font-size:14px; margin-top:8px; }
</style>
</head>
<body>
  <h1>MEDBI — Generar código de activación</h1>
  <input type="password" id="adminKey" placeholder="Tu clave de administrador">
  <select id="appId">
    <option value="guia-guardia">MEDBI Medicina Interna</option>
    <option value="biologia-pre-medico">MEDBI Biologia Pré-Médico</option>
  </select>
  <select id="plan">
    <option value="monthly">Mensal — 250 FCFA (30 dias)</option>
    <option value="annual">Anual — 2500 FCFA (365 dias)</option>
  </select>
  <button id="genBtn">Generar código</button>
  <div id="result"></div>
  <div id="err"></div>

  <h1 style="margin-top:32px;">Atualizar "grátis até" (afeta quem já ativou)</h1>
  <select id="expiryAppId">
    <option value="guia-guardia">MEDBI Medicina Interna</option>
    <option value="biologia-pre-medico">MEDBI Biologia Pré-Médico</option>
  </select>
  <input type="date" id="freeUntilDate">
  <button id="updateExpiryBtn">Atualizar data</button>
  <div id="expiryResult"></div>

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

    document.getElementById('updateExpiryBtn').addEventListener('click', async () => {
      const key = document.getElementById('adminKey').value;
      const appId = document.getElementById('expiryAppId').value;
      const dateVal = document.getElementById('freeUntilDate').value; // AAAA-MM-DD
      const out = document.getElementById('expiryResult');
      out.textContent = '';
      if (!key) { out.textContent = '❌ Mete a tua clave de administrador em cima.'; return; }
      if (!dateVal) { out.textContent = '❌ Escolhe uma data.'; return; }
      try {
        const res = await fetch('/api/store/update-license-expiry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify({ appId, freeUntil: dateVal + 'T23:59:59Z' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro');
        out.textContent = '✅ Atualizado. ' + data.licensesUpdated + ' licença(s) já ativas mudaram também.';
      } catch (e) {
        out.textContent = '❌ ' + e.message;
      }
    });
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MEDBI license server escuchando en puerto ${PORT}`));
