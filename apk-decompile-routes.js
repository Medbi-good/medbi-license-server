// apk-decompile-routes.js
//
// Router Express para o "apk-unpack": espelho inverso do apk-build-routes.js.
// Em vez de enviar ficheiros e receber um .apk, envia-se um .apk e recebe-se
// o código smali (apktool), o Java aproximado (jadx) e os recursos/manifest,
// compactados num .zip publicado como asset de uma release do GitHub.
//
// Como integrar no teu backend Express existente (o mesmo do MEDBI Store):
//
//   const apkDecompileRoutes = require('./apk-decompile-routes');
//   app.use('/api/apk-decompile', apkDecompileRoutes);
//
// Precisa de Node 18+ (fetch global). Não precisa de nenhuma dependência nova
// (o .apk viaja como base64 dentro do JSON, tal como os ficheiros do apk-build
// — por isso o servidor já tem de aceitar `express.json({ limit: '100mb' })`,
// o que já está definido no server.js principal).
//
// TOKEN DO GITHUB — reutiliza a mesma variável de ambiente do apk-builder:
//   GITHUB_TOKEN = ghp_xxxxxxxxxxxxxxxxxxxx
// (scopes: "repo", ou "Contents: write" + "Actions: write" em fine-grained)
//
// CHAVE DE ACESSO AO PRÓPRIO ENDPOINT — obrigatória, variável própria para
// não misturar com a do apk-builder:
//   APK_UNPACK_API_KEY = uma-frase-longa-só-tua-que-ninguém-adivinha
// E no frontend (index.html do desmontador), escreve essa chave no campo
// "Chave de acesso" (fica guardada no localStorage do telemóvel).
//
// Espera um ficheiro .github/workflows/decompile.yml no repositório (ver
// ficheiro em anexo), que corre apktool + jadx e publica uma release com tag
// "decompile-<jobId>".

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_KEY = process.env.APK_UNPACK_API_KEY;

function isValidApiKey(provided) {
  if (!API_KEY || typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ error: 'servidor sem APK_UNPACK_API_KEY configurado — define esta variável de ambiente no Render antes de usar o apk-unpack.' });
  }
  const provided = req.get('x-api-key');
  if (!isValidApiKey(provided)) {
    return res.status(401).json({ error: 'chave de acesso em falta ou inválida.' });
  }
  next();
}
router.use(requireApiKey);

// ---------- Estado dos jobs (em memória, igual ao apk-build) ----------
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function newJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const job = { id, status: 'running', log: [], downloadUrl: null, tree: null, createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}
function log(job, msg, level) { job.log.push({ msg, level: level || 'dim', t: Date.now() }); }
function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) { if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id); }
}
setInterval(cleanupOldJobs, 5 * 60 * 1000).unref();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- Helper: chamada à API do GitHub ----------
async function ghApi(path, opts, token) {
  return fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts && opts.headers ? opts.headers : {}),
    },
  });
}

async function getBranchHeadCommit(owner, repoName, token, branch) {
  const refRes = await ghApi(`/repos/${owner}/${repoName}/git/ref/heads/${branch}`, {}, token);
  if (!refRes.ok) {
    const err = await refRes.json().catch(() => ({}));
    throw new Error(`não consegui obter o branch "${branch}": ${err.message || refRes.status}`);
  }
  return (await refRes.json()).object.sha;
}

// Commita um único ficheiro binário (o .apk, em base64) em incoming/<jobId>.apk.
// Feito num único commit via Git Data API (blob + tree + commit + update ref),
// tal como o apk-build faz para vários ficheiros de uma vez.
async function commitApkToRepo(owner, repoName, token, branch, path, base64Content) {
  const headSha = await getBranchHeadCommit(owner, repoName, token, branch);
  const baseCommitRes = await ghApi(`/repos/${owner}/${repoName}/git/commits/${headSha}`, {}, token);
  if (!baseCommitRes.ok) throw new Error('não consegui ler o commit base.');
  const baseTreeSha = (await baseCommitRes.json()).tree.sha;

  const blobRes = await ghApi(
    `/repos/${owner}/${repoName}/git/blobs`,
    { method: 'POST', body: JSON.stringify({ content: base64Content, encoding: 'base64' }) },
    token
  );
  if (!blobRes.ok) throw new Error('falha ao criar o blob do apk.');
  const blobSha = (await blobRes.json()).sha;

  const treeRes = await ghApi(
    `/repos/${owner}/${repoName}/git/trees`,
    { method: 'POST', body: JSON.stringify({ base_tree: baseTreeSha, tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }] }) },
    token
  );
  if (!treeRes.ok) throw new Error('falha ao criar a tree.');
  const newTreeSha = (await treeRes.json()).sha;

  const commitRes = await ghApi(
    `/repos/${owner}/${repoName}/git/commits`,
    { method: 'POST', body: JSON.stringify({ message: `apk-unpack: receber ${path}`, tree: newTreeSha, parents: [headSha] }) },
    token
  );
  if (!commitRes.ok) throw new Error('falha ao criar o commit.');
  const newCommitSha = (await commitRes.json()).sha;

  const updateRes = await ghApi(
    `/repos/${owner}/${repoName}/git/refs/heads/${branch}`,
    { method: 'PATCH', body: JSON.stringify({ sha: newCommitSha }) },
    token
  );
  if (!updateRes.ok) throw new Error('falha ao atualizar o branch.');
  return newCommitSha;
}

// Converte o texto simples de tree.txt (um caminho por linha, ex:
// "manifest/AndroidManifest.xml") numa árvore aninhada {name, type, children}
// para a UI desenhar.
function parseTreeTxt(text) {
  const root = { name: '.', type: 'dir', children: [] };
  text.split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
    const parts = line.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, type: isFile ? 'file' : 'dir', children: [] };
        node.children.push(child);
      }
      node = child;
    });
  });
  return root;
}

// ---------- Fluxo principal (corre em background) ----------
async function runDecompile(job, { owner, repoName, token, branch, apkPath, apkBase64, wantSmali, wantJava, wantResources, appOnly }) {
  try {
    log(job, `a enviar o apk para o repositório (${apkPath})...`, 'dim');
    await commitApkToRepo(owner, repoName, token, branch, apkPath, apkBase64);
    log(job, '✓ apk recebido no repositório.', 'ok');

    log(job, 'a disparar workflow decompile.yml...', 'dim');
    const dispatchedAt = Date.now();
    const dispatch = await ghApi(
      `/repos/${owner}/${repoName}/actions/workflows/decompile.yml/dispatches`,
      { method: 'POST', body: JSON.stringify({
        ref: branch,
        inputs: {
          job_id: job.id,
          apk_path: apkPath,
          want_smali: String(wantSmali),
          want_java: String(wantJava),
          want_resources: String(wantResources),
          app_only: String(appOnly),
        },
      }) },
      token
    );
    if (dispatch.status !== 204) {
      const err = await dispatch.json().catch(() => ({}));
      log(job, `não consegui disparar o workflow: ${err.message || dispatch.status}`, 'err');
      log(job, `confirma que .github/workflows/decompile.yml existe no branch "${branch}".`, 'warn');
      job.status = 'error';
      return;
    }
    log(job, 'workflow disparado. à espera que o GitHub Actions comece a correr...', 'ok');

    const CLOCK_SKEW_MS = 5000;
    const dispatchThreshold = dispatchedAt - CLOCK_SKEW_MS;
    let runId = null;
    for (let attempts = 0; attempts < 20 && !runId; attempts++) {
      await sleep(2000);
      const runsRes = await ghApi(`/repos/${owner}/${repoName}/actions/workflows/decompile.yml/runs?event=workflow_dispatch&per_page=10`, {}, token);
      const runsJson = await runsRes.json().catch(() => ({}));
      const candidates = (runsJson.workflow_runs || [])
        .filter((r) => new Date(r.created_at).getTime() >= dispatchThreshold)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (candidates.length) runId = candidates[0].id;
    }
    if (!runId) {
      log(job, 'não encontrei o run. Verifica manualmente no separador Actions do repositório.', 'err');
      job.status = 'error';
      return;
    }
    log(job, `run encontrado (#${runId}). A acompanhar progresso...`, 'ok');

    let status = 'queued', conclusion = null, runUrl = null;
    while (status !== 'completed') {
      await sleep(4000);
      const runRes = await ghApi(`/repos/${owner}/${repoName}/actions/runs/${runId}`, {}, token);
      const runJson = await runRes.json().catch(() => ({}));
      status = runJson.status; conclusion = runJson.conclusion; runUrl = runJson.html_url;
      log(job, `estado: ${status}`, 'dim');
    }
    if (conclusion !== 'success') {
      log(job, `desmontagem falhou (conclusão: ${conclusion}).`, 'err');
      if (runUrl) log(job, `vê os logs completos em: ${runUrl}`, 'warn');
      job.status = 'error';
      return;
    }
    log(job, 'desmontagem concluída com sucesso!', 'ok');

    log(job, 'a procurar a release com o resultado...', 'dim');
    const tag = `decompile-${job.id}`;
    const relRes = await ghApi(`/repos/${owner}/${repoName}/releases/tags/${tag}`, {}, token);
    if (!relRes.ok) {
      log(job, 'release não encontrada. Confirma no separador Releases do repositório.', 'err');
      job.status = 'error';
      return;
    }
    const relJson = await relRes.json();
    const zipAsset = (relJson.assets || []).find((a) => a.name.endsWith('.zip'));
    const treeAsset = (relJson.assets || []).find((a) => a.name === 'tree.txt');
    if (!zipAsset) {
      log(job, 'release encontrada mas sem .zip anexado.', 'warn');
      job.status = 'error';
      return;
    }
    job.downloadUrl = zipAsset.browser_download_url;
    log(job, `zip disponível: ${zipAsset.name}`, 'ok');

    if (treeAsset) {
      const treeRes = await fetch(treeAsset.browser_download_url);
      if (treeRes.ok) job.tree = parseTreeTxt(await treeRes.text());
    }
    job.status = 'done';
  } catch (e) {
    log(job, 'erro inesperado no servidor: ' + (e && e.message ? e.message : String(e)), 'err');
    job.status = 'error';
  }
}

// ---------- Rotas ----------

// POST /api/apk-decompile/start
// body: { repo: "owner/repo", branch?: "main", apkName, apkBase64,
//         options: { smali: bool, java: bool, resources: bool, appOnly: bool } }
router.post('/start', express.json({ limit: '100mb' }), (req, res) => {
  const { repo, branch, apkName, apkBase64, options } = req.body || {};
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'servidor sem GITHUB_TOKEN configurado.' });
  }
  if (!repo || !apkBase64) {
    return res.status(400).json({ error: 'faltam campos: repo ou apkBase64.' });
  }
  const [owner, repoName] = String(repo).trim().split('/');
  if (!owner || !repoName) {
    return res.status(400).json({ error: 'formato do repositório inválido — tem de ser owner/repo.' });
  }
  const opts = options || {};

  const job = newJob();
  res.json({ jobId: job.id });

  const safeName = (apkName || 'app.apk').replace(/[^a-zA-Z0-9._-]/g, '_');
  const apkPath = `incoming/${job.id}-${safeName}`;

  runDecompile(job, {
    owner, repoName, token: GITHUB_TOKEN, branch: branch || 'main',
    apkPath, apkBase64,
    wantSmali: opts.smali !== false, wantJava: opts.java !== false, wantResources: opts.resources !== false,
    appOnly: opts.appOnly !== false,
  });
});

// GET /api/apk-decompile/:id
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job não encontrado (pode ter expirado).' });
  res.json({ status: job.status, log: job.log, downloadUrl: job.downloadUrl, tree: job.tree });
});

module.exports = router;
