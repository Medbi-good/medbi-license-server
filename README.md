# MEDBI License Server

Servidor mínimo (Node.js + Express + Postgres) que resuelve los 4 endpoints
que ya llaman tus apps:

- `GET  /api/store/apps`
- `POST /api/store/generate-code`
- `POST /api/activate`
- `POST /api/validate`

## Paso 1 — Base de datos (Supabase, gratis)

1. Entra a https://supabase.com → crea cuenta → **New project**.
2. Cuando termine de crearse, ve a **Project Settings → Database → Connection string → URI**.
   Copia esa URL (empieza con `postgresql://postgres:...`).
3. Ve a **SQL Editor → New query**, pega el contenido de `schema.sql` y dale **Run**.
   Esto crea las tablas `apps`, `codes`, `licenses` y agrega la app `guia-guardia`.

## Paso 2 — Desplegar el servidor (Render, gratis)

1. Sube esta carpeta (`license-server/`) a un repo de GitHub (puede ser privado).
2. Entra a https://render.com → **New → Web Service** → conecta ese repo.
3. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. En **Environment**, agrega la variable:
   - `DATABASE_URL` = la URL que copiaste de Supabase en el Paso 1.
5. Dale **Create Web Service**. Cuando termine el deploy, Render te da una URL pública,
   algo como `https://medbi-license-server.onrender.com`.

> Nota: en el plan gratis de Render el servicio "duerme" tras 15 min sin uso y tarda
> unos segundos en despertar con la primera petición. Para un servidor de licencias
> de bajo tráfico esto normalmente no es problema.

## Paso 3 — Conectar tus apps al servidor real

En **ambos** archivos edita la constante con la URL real (sin barra `/` al final):

- `guia-guardia` (activation-gate): busca
  `const API_BASE = 'https://TU-SERVIDOR.example.com/api';`
  y cámbiala por
  `const API_BASE = 'https://medbi-license-server.onrender.com/api';`

- `medbi-store` (index.html): busca
  `const SERVER_ORIGIN = 'https://TU-SERVIDOR.example.com';`
  y cámbiala por
  `const SERVER_ORIGIN = 'https://medbi-license-server.onrender.com';`

(usa la URL que Render te dio a ti, no esta de ejemplo).

## Paso 4 — Probar antes de subir a AppMint

Desde el navegador o con curl, prueba que el servidor responde:

```
curl https://TU-URL-REAL.onrender.com/api/store/apps
```

Debe devolver `{"apps":[{"id":"guia-guardia", ...}]}`.

Luego prueba generar un código y activarlo, para confirmar que todo el flujo
funciona antes de volver a empaquetar los zips para AppMint.

## Agregar más apps al catálogo más adelante

Simplemente inserta una fila nueva en la tabla `apps` desde el SQL Editor de Supabase,
con un `id` único (ej. `'otra-app'`) — no hace falta tocar el código del servidor.
