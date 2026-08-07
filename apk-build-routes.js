// apk-build-routes.js
//
// Router Express para o "apk-builder": faz TODO o diálogo com a API do GitHub
// (verificar repo, enviar ficheiros, disparar workflow, seguir o build, encontrar
// a release) do lado do servidor. O telemóvel só faz 1 pedido para iniciar e
// pedidos leves de status a cada poucos segundos — nada de sequências longas
// de fetch sobre ligação móvel fraca.
//
// Como integrar no teu backend Express existente (o mesmo do MEDBI Store):
//
//   const apkBuildRoutes = require('./apk-build-routes');
//   app.use('/api/apk-build', apkBuildRoutes);
//
// Precisa de Node 18+ (fetch global). Não precisa de nenhuma dependência nova.
//
// TOKEN DO GITHUB — configuração obrigatória:
// O Personal Access Token deixou de vir do browser (não é seguro pedir ao
// utilizador para o escrever a cada build). Define-o como variável de
// ambiente no servidor (no Render: Settings → Environment → Add Environment
// Variable):
//
//   GITHUB_TOKEN = ghp_xxxxxxxxxxxxxxxxxxxx
//
// Scopes mínimos necessários no token: "repo" (ou, com fine-grained token,
// "Contents: write" + "Actions: write" no repositório MEDBI-APK).

const express = require('express');
const router = express.Router();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ---------- Estado dos jobs (em memória) ----------
// Suficiente para builds pontuais disparados manualmente. Se o servidor
// reiniciar a meio de um build, o job perde-se — o utilizador só tem de
// tentar de novo. Não persiste em BD de propósito (simplicidade).
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000; // limpa jobs com mais de 30 min

function newJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const job = {
    id,
    status: 'running', // running | done | error
    log: [],
    downloadUrl: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function log(job, msg, level) {
  job.log.push({ msg, level: level || 'dim', t: Date.now() });
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}
setInterval(cleanupOldJobs, 5 * 60 * 1000).unref();

// ---------- Helper: chamada à API do GitHub (servidor → GitHub, ligação estável) ----------
async function ghApi(path, opts, token) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts && opts.headers ? opts.headers : {}),
    },
  });
  return res;
}

async function uploadFileToRepo(owner, repoName, token, path, base64content, commitMessage) {
  let sha;
  const existing = await ghApi(`/repos/${owner}/${repoName}/contents/${path}`, {}, token);
  if (existing.ok) {
    const j = await existing.json();
    sha = j.sha;
  }
  return ghApi(
    `/repos/${owner}/${repoName}/contents/${path}`,
    { method: 'PUT', body: JSON.stringify({ message: commitMessage, content: base64content, sha }) },
    token
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- O fluxo todo, a correr em background no servidor ----------
async function runBuild(job, { owner, repoName, token, appName, packageId, mode, liveUrl, files, iconBase64, outputFormat }) {
  try {
    log(job, 'a verificar acesso ao repositório...', 'dim');
    const check = await ghApi(`/repos/${owner}/${repoName}`, {}, token);
    if (!check.ok) {
      log(job, `não consegui aceder a ${owner}/${repoName} — verifica o token e o nome do repositório.`, 'err');
      job.status = 'error';
      return;
    }
    log(job, 'repositório encontrado.', 'ok');

    if (mode === 'url') {
      // Modo "vivo": não embutimos nada. O www/ local fica só com um placeholder
      // mínimo (o build-apk.yml deve gerar capacitor.config.json com
      // server.url = liveUrl, apontando o WebView direto para o site publicado —
      // sem isto o Capacitor falha por não encontrar pasta www/).
      log(job, `modo URL — a app vai apontar para ${liveUrl}, sem embutir ficheiros.`, 'dim');
      const placeholder = '<!doctype html><html><body>A carregar…</body></html>';
      const put = await uploadFileToRepo(
        owner, repoName, token, 'www/index.html',
        Buffer.from(placeholder, 'utf8').toString('base64'),
        'build: placeholder www/ (modo url) via apk-builder'
      );
      if (!put.ok) {
        const err = await put.json().catch(() => ({}));
        log(job, `falha ao enviar placeholder www/index.html: ${err.message || put.status}`, 'err');
        job.status = 'error';
        return;
      }
      log(job, '✓ placeholder www/index.html enviado.', 'ok');
    } else {
      log(job, `a enviar ${files.length} ficheiro(s) para www/...`, 'dim');
      for (const f of files) {
        const put = await uploadFileToRepo(owner, repoName, token, f.path, f.base64, 'build: atualizar ' + f.path + ' via apk-builder');
        if (!put.ok) {
          const err = await put.json().catch(() => ({}));
          log(job, `falha ao enviar ${f.path}: ${err.message || put.status}`, 'err');
          job.status = 'error';
          return;
        }
        log(job, `✓ ${f.path}`, 'dim');
      }
      log(job, 'todos os ficheiros enviados.', 'ok');
    }

    if (iconBase64) {
      log(job, 'a enviar ícone...', 'dim');
      const iconPut = await uploadFileToRepo(owner, repoName, token, 'resources/icon.png', iconBase64, 'build: atualizar ícone via apk-builder');
      if (!iconPut.ok) {
        const err = await iconPut.json().catch(() => ({}));
        log(job, `falha ao enviar ícone: ${err.message || iconPut.status}`, 'err');
        job.status = 'error';
        return;
      }
      log(job, 'ícone enviado.', 'ok');
    }

    log(job, `a disparar workflow build-apk.yml (formato: ${outputFormat.toUpperCase()})...`, 'dim');
    const dispatch = await ghApi(
      `/repos/${owner}/${repoName}/actions/workflows/build-apk.yml/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            app_name: appName,
            package_id: packageId,
            source_mode: mode === 'url' ? 'url' : 'file',
            source_url: mode === 'url' ? liveUrl : '',
            output_format: outputFormat,
          },
        }),
      },
      token
    );
    if (dispatch.status !== 204) {
      const err = await dispatch.json().catch(() => ({}));
      log(job, `não consegui disparar o workflow: ${err.message || dispatch.status}`, 'err');
      log(job, 'confirma que .github/workflows/build-apk.yml existe no branch "main".', 'warn');
      job.status = 'error';
      return;
    }
    log(job, 'workflow disparado. à espera que o GitHub Actions comece a correr...', 'ok');

    let runId = null;
    for (let attempts = 0; attempts < 15 && !runId; attempts++) {
      await sleep(3000);
      const runsRes = await ghApi(`/repos/${owner}/${repoName}/actions/workflows/build-apk.yml/runs?per_page=1`, {}, token);
      const runsJson = await runsRes.json().catch(() => ({}));
      if (runsJson.workflow_runs && runsJson.workflow_runs.length) runId = runsJson.workflow_runs[0].id;
    }
    if (!runId) {
      log(job, 'não encontrei o run. Verifica manualmente no separador Actions do repositório.', 'err');
      job.status = 'error';
      return;
    }
    log(job, `run encontrado (#${runId}). A acompanhar progresso...`, 'ok');

    let status = 'queued';
    let conclusion = null;
    let runUrl = null;
    while (status !== 'completed') {
      await sleep(6000);
      const runRes = await ghApi(`/repos/${owner}/${repoName}/actions/runs/${runId}`, {}, token);
      const runJson = await runRes.json().catch(() => ({}));
      status = runJson.status;
      conclusion = runJson.conclusion;
      runUrl = runJson.html_url;
      log(job, `estado: ${status}`, 'dim');
    }
    if (conclusion !== 'success') {
      log(job, `build falhou (conclusão: ${conclusion}).`, 'err');
      if (runUrl) log(job, `vê os logs completos em: ${runUrl}`, 'warn');
      job.status = 'error';
      return;
    }
    log(job, 'build concluído com sucesso!', 'ok');

    log(job, `a procurar a release com o ${outputFormat.toUpperCase()}...`, 'dim');
    const releasesRes = await ghApi(`/repos/${owner}/${repoName}/releases?per_page=1&_=${Date.now()}`, {}, token);
    const releasesJson = await releasesRes.json().catch(() => ([]));
    const ext = '.' + outputFormat;
    const asset = releasesJson[0] && releasesJson[0].assets && releasesJson[0].assets.find((a) => a.name.endsWith(ext));
    if (asset) {
      log(job, `${outputFormat.toUpperCase()} disponível: ${asset.name}`, 'ok');
      job.downloadUrl = asset.browser_download_url;
      job.status = 'done';
    } else {
      log(job, `release encontrada mas sem ficheiro ${ext} anexado. Confirma no separador Releases do repositório.`, 'warn');
      job.status = 'error';
    }
  } catch (e) {
    log(job, 'erro inesperado no servidor: ' + (e && e.message ? e.message : String(e)), 'err');
    job.status = 'error';
  }
}

// ---------- Rotas ----------

// POST /api/apk-build/start
// body: { repo: "owner/repo", appName, packageId, mode: "url"|"file"|"zip",
//         outputFormat?: "apk"|"aab" (default "apk"),
//         liveUrl?: "https://...", files: [{path, base64}], iconBase64? }
// - O token do GitHub já não vem no body — lê-se de process.env.GITHUB_TOKEN.
// - mode "url": liveUrl obrigatório, files é ignorado (não é preciso embutir nada).
// - mode "file"/"zip": files obrigatório (o front-end já resolveu ambos para a mesma forma).
router.post('/start', express.json({ limit: '100mb' }), (req, res) => {
  const { repo, appName, packageId, mode, liveUrl, files, iconBase64, outputFormat } = req.body || {};
  const effectiveMode = mode === 'url' ? 'url' : 'file';
  const effectiveFormat = outputFormat === 'aab' ? 'aab' : 'apk';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'servidor sem GITHUB_TOKEN configurado — define esta variável de ambiente no Render antes de usar o apk-builder.' });
  }
  if (!repo || !appName || !packageId) {
    return res.status(400).json({ error: 'faltam campos: repo, appName ou packageId.' });
  }
  if (effectiveMode === 'url') {
    if (!liveUrl || typeof liveUrl !== 'string') {
      return res.status(400).json({ error: 'modo url requer liveUrl.' });
    }
  } else if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'faltam ficheiros (files) para o modo escolhido.' });
  }

  const [owner, repoName] = String(repo).trim().split('/');
  if (!owner || !repoName) {
    return res.status(400).json({ error: 'formato do repositório inválido — tem de ser owner/repo.' });
  }

  const job = newJob();
  job.outputFormat = effectiveFormat;
  res.json({ jobId: job.id });

  // corre em background — a resposta HTTP já foi enviada
  runBuild(job, { owner, repoName, token: GITHUB_TOKEN, appName, packageId, mode: effectiveMode, liveUrl, files: files || [], iconBase64, outputFormat: effectiveFormat });
});

// GET /api/apk-build/:id
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job não encontrado (pode ter expirado).' });
  res.json({ status: job.status, log: job.log, downloadUrl: job.downloadUrl, outputFormat: job.outputFormat });
});

module.exports = router;
