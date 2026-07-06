-- Ejecuta esto una sola vez en el SQL Editor de Supabase (o de tu Postgres)

CREATE TABLE IF NOT EXISTS apps (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  version     TEXT,
  size_mb     NUMERIC,
  published   BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS codes (
  code         TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps(id),
  used         BOOLEAN DEFAULT false,
  device_id    TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  activated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS licenses (
  license    TEXT PRIMARY KEY,
  code       TEXT REFERENCES codes(code),
  app_id     TEXT NOT NULL REFERENCES apps(id),
  device_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- App inicial: Guia de Guardia. Edita/agrega filas aquí cuando publiques más apps.
INSERT INTO apps (id, name, description, icon, version, size_mb)
VALUES ('guia-guardia', 'MEDBI — Guia de Guardia', 'Guía de emergencias médicas bilingüe PT/ES con calculadoras clínicas', '🩺', '1.0.0', 15)
ON CONFLICT (id) DO NOTHING;
