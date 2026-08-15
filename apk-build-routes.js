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
//
// CHAVE DE ACESSO AO PRÓPRIO ENDPOINT — configuração obrigatória:
// Sem isto, qualquer pessoa que descubra o URL deste backend no Render
// consegue disparar builds em teu nome (o GITHUB_TOKEN vive no servidor,
// não no browser, por isso nada o protege sozinho). Define também:
//
//   APK_BUILDER_API_KEY = uma-frase-longa-só-tua-que-ninguém-adivinha
//
// E no frontend (indexapk.html), escreve essa mesma chave no campo
// "Chave de acesso" (fica guardada no localStorage do teu telemóvel,
// não precisas de a escrever a cada build).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_KEY = process.env.APK_BUILDER_API_KEY;

// Comparação em tempo constante — evita que um atacante consiga adivinhar a
// chave carácter a carácter medindo quanto tempo demora cada tentativa.
function isValidApiKey(provided) {
  if (!API_KEY || typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Middleware: exige o header x-api-key em todas as rotas deste router.
function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ error: 'servidor sem APK_BUILDER_API_KEY configurado — define esta variável de ambiente no Render antes de usar o apk-builder.' });
  }
  const provided = req.get('x-api-key');
  if (!isValidApiKey(provided)) {
    return res.status(401).json({ error: 'chave de acesso em falta ou inválida.' });
  }
  next();
}
router.use(requireApiKey);

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

async function getBranchHeadCommit(owner, repoName, token, branch) {
  const refRes = await ghApi(`/repos/${owner}/${repoName}/git/ref/heads/${branch}`, {}, token);
  if (!refRes.ok) {
    const err = await refRes.json().catch(() => ({}));
    throw new Error(`não consegui obter o branch "${branch}": ${err.message || refRes.status}`);
  }
  const refJson = await refRes.json();
  return refJson.object.sha;
}

// Envia TODOS os ficheiros (www/ + ícone) num único commit via Git Data API,
// em vez de 1 GET (sha existente) + 1 PUT por ficheiro via Contents API.
// Os blobs são criados em paralelo — isto é o que mais reduz o tempo de
// build quando há várias dezenas de ficheiros (ex: modo ZIP), porque troca
// N pedidos sequenciais por um pequeno número de pedidos, a maioria em paralelo.
// Também limpa, no mesmo commit, quaisquer ficheiros dentro de www/ que já
// não fazem parte deste envio (ex: mudaste de ZIP com várias páginas para
// um único ficheiro HTML) — evita lixo a acumular-se no repositório.
// extraDeletePaths: caminhos fora de www/ a apagar explicitamente neste
// commit (ex: 'resources/icon.png' quando o utilizador remove o ícone) —
// sem isto, o ficheiro antigo ficava esquecido no repo e continuava a ser
// usado nos builds seguintes mesmo depois de "removido" no formulário.
async function commitFilesToRepo(owner, repoName, token, branch, files, commitMessage, job, extraDeletePaths) {
  const headSha = await getBranchHeadCommit(owner, repoName, token, branch);

  const baseCommitRes = await ghApi(`/repos/${owner}/${repoName}/git/commits/${headSha}`, {}, token);
  if (!baseCommitRes.ok) throw new Error('não consegui ler o commit base.');
  const baseCommitJson = await baseCommitRes.json();
  const baseTreeSha = baseCommitJson.tree.sha;

  const existingTreeRes = await ghApi(`/repos/${owner}/${repoName}/git/trees/${baseTreeSha}?recursive=1`, {}, token);
  const existingTreeJson = existingTreeRes.ok ? await existingTreeRes.json().catch(() => ({ tree: [] })) : { tree: [] };
  const existingWwwPaths = (existingTreeJson.tree || [])
    .filter((e) => e.type === 'blob' && e.path.startsWith('www/'))
    .map((e) => e.path);
  const existingAllPaths = new Set((existingTreeJson.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));

  const newWwwPaths = new Set(files.filter((f) => f.path.startsWith('www/')).map((f) => f.path));
  const stalePaths = existingWwwPaths.filter((p) => !newWwwPaths.has(p));
  if (stalePaths.length && job) {
    log(job, `a remover ${stalePaths.length} ficheiro(s) antigo(s) de www/ que já não fazem parte deste build...`, 'dim');
  }

  // Só apagamos os extras que de facto existem no repo (e que este envio não
  // está já a substituir por um ficheiro novo com o mesmo caminho).
  const newPathsThisCommit = new Set(files.map((f) => f.path));
  const confirmedDeletePaths = (extraDeletePaths || []).filter(
    (p) => existingAllPaths.has(p) && !newPathsThisCommit.has(p)
  );
  if (confirmedDeletePaths.length && job) {
    log(job, `a remover: ${confirmedDeletePaths.join(', ')}...`, 'dim');
  }

  const treeEntries = await mapWithConcurrency(files, 10, async (f) => {
    const blobRes = await ghApi(
      `/repos/${owner}/${repoName}/git/blobs`,
      { method: 'POST', body: JSON.stringify({ content: f.base64, encoding: 'base64' }) },
      token
    );
    if (!blobRes.ok) {
      const err = await blobRes.json().catch(() => ({}));
      throw new Error(`falha ao criar blob para ${f.path}: ${err.message || blobRes.status}`);
    }
    const blobJson = await blobRes.json();
    return { path: f.path, mode: '100644', type: 'blob', sha: blobJson.sha };
  });

  // sha: null remove a entrada da árvore — é assim que a Git Trees API apaga ficheiros.
  for (const stalePath of stalePaths) {
    treeEntries.push({ path: stalePath, mode: '100644', type: 'blob', sha: null });
  }
  for (const deletePath of confirmedDeletePaths) {
    treeEntries.push({ path: deletePath, mode: '100644', type: 'blob', sha: null });
  }

  const treeRes = await ghApi(
    `/repos/${owner}/${repoName}/git/trees`,
    { method: 'POST', body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }) },
    token
  );
  if (!treeRes.ok) {
    const err = await treeRes.json().catch(() => ({}));
    throw new Error('falha ao criar a árvore git: ' + (err.message || treeRes.status));
  }
  const treeJson = await treeRes.json();

  const commitRes = await ghApi(
    `/repos/${owner}/${repoName}/git/commits`,
    { method: 'POST', body: JSON.stringify({ message: commitMessage, tree: treeJson.sha, parents: [headSha] }) },
    token
  );
  if (!commitRes.ok) {
    const err = await commitRes.json().catch(() => ({}));
    throw new Error('falha ao criar o commit: ' + (err.message || commitRes.status));
  }
  const commitJson = await commitRes.json();

  const updateRefRes = await ghApi(
    `/repos/${owner}/${repoName}/git/refs/heads/${branch}`,
    { method: 'PATCH', body: JSON.stringify({ sha: commitJson.sha }) },
    token
  );
  if (!updateRefRes.ok) {
    const err = await updateRefRes.json().catch(() => ({}));
    throw new Error(`falha ao atualizar o branch "${branch}": ` + (err.message || updateRefRes.status));
  }
  return commitJson.sha;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Corre fn sobre items com um máximo de `limit` chamadas em simultâneo — evita
// disparar centenas de pedidos paralelos à API do GitHub (que pode acionar o
// "secondary rate limit" / abuse detection em ZIPs com muitos ficheiros).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- Validação simples de cor hex (#RRGGBB) ----------
const DEFAULT_SPLASH_COLOR = '#FDE2DD';
function sanitizeHexColor(value) {
  if (typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value.trim())) {
    return value.trim().toUpperCase();
  }
  return DEFAULT_SPLASH_COLOR;
}

// ---------- O fluxo todo, a correr em background no servidor ----------
async function runBuild(job, { owner, repoName, token, appName, packageId, mode, liveUrl, files, iconBase64, outputFormat, splashColor, removeIcon, decompiledZipBase64, keepOriginalPackage, forceNewKeystore }) {
  const safeSplashColor = sanitizeHexColor(splashColor);
  try {
    log(job, 'a verificar acesso ao repositório...', 'dim');
    const check = await ghApi(`/repos/${owner}/${repoName}`, {}, token);
    if (!check.ok) {
      log(job, `não consegui aceder a ${owner}/${repoName} — verifica o token e o nome do repositório.`, 'err');
      job.status = 'error';
      return;
    }
    const repoJson = await check.json().catch(() => ({}));
    const branch = repoJson.default_branch || 'main';
    log(job, `repositório encontrado (branch: ${branch}).`, 'ok');

    const filesToCommit = [];
    if (mode === 'decompiled') {
      // Projeto já descompilado (apktool d): um único ficheiro binário na
      // raiz do repo, decompiled.zip — o build-apk.yml extrai-o e reconstrói
      // com apktool. Não passa por www/ nem por Capacitor.
      log(job, 'modo decompiled — a enviar decompiled.zip (projeto smali/+res/) para a raiz do repositório...', 'dim');
      filesToCommit.push({ path: 'decompiled.zip', base64: decompiledZipBase64 });
    } else if (mode === 'url') {
      // Modo "vivo": não embutimos nada. O www/ local fica só com um placeholder
      // mínimo (o build-apk.yml deve gerar capacitor.config.json com
      // server.url = liveUrl, apontando o WebView direto para o site publicado —
      // sem isto o Capacitor falha por não encontrar pasta www/).
      log(job, `modo URL — a app vai apontar para ${liveUrl}, sem embutir ficheiros.`, 'dim');
      const placeholder = '<!doctype html><html><body>A carregar…</body></html>';
      filesToCommit.push({ path: 'www/index.html', base64: Buffer.from(placeholder, 'utf8').toString('base64') });
    } else {
      log(job, `a preparar ${files.length} ficheiro(s) para www/...`, 'dim');
      filesToCommit.push(...files);
    }
    if (mode !== 'decompiled' && iconBase64) {
      filesToCommit.push({ path: 'resources/icon.png', base64: iconBase64 });
    }
    // O utilizador pediu explicitamente para voltar ao ícone padrão do
    // Capacitor — apagamos o ficheiro antigo do repo em vez de o deixar lá
    // (senão o próximo build continuava a encontrá-lo e a usá-lo).
    const extraDeletePaths = (mode !== 'decompiled' && removeIcon && !iconBase64) ? ['resources/icon.png'] : [];
    if (extraDeletePaths.length) {
      log(job, 'ícone removido pelo utilizador — a apagar resources/icon.png do repositório...', 'dim');
    }

    log(job, `a enviar ${filesToCommit.length} ficheiro(s) num único commit...`, 'dim');
    try {
      const commitSha = await commitFilesToRepo(
        owner, repoName, token, branch, filesToCommit,
        'build: atualizar conteúdo via apk-builder', job, extraDeletePaths
      );
      log(job, `✓ commit único enviado (${commitSha.slice(0, 7)}).`, 'ok');
    } catch (e) {
      log(job, e.message || String(e), 'err');
      job.status = 'error';
      return;
    }

    log(job, `a disparar workflow build-apk.yml (formato: ${outputFormat.toUpperCase()}, splash: ${safeSplashColor})...`, 'dim');
    const dispatchedAt = Date.now();
    const dispatch = await ghApi(
      `/repos/${owner}/${repoName}/actions/workflows/build-apk.yml/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: branch,
          inputs: {
            app_name: appName,
            package_id: packageId,
            source_mode: mode === 'decompiled' ? 'decompiled' : (mode === 'url' ? 'url' : 'file'),
            source_url: mode === 'url' ? liveUrl : '',
            output_format: outputFormat,
            splash_color: safeSplashColor,
            keep_original_package: keepOriginalPackage === false ? 'nao' : 'sim',
            force_new_keystore: forceNewKeystore === true ? 'sim' : 'nao',
          },
        }),
      },
      token
    );
    if (dispatch.status !== 204) {
      const err = await dispatch.json().catch(() => ({}));
      log(job, `não consegui disparar o workflow: ${err.message || dispatch.status}`, 'err');
      log(job, `confirma que .github/workflows/build-apk.yml existe no branch "${branch}".`, 'warn');
      job.status = 'error';
      return;
    }
    log(job, 'workflow disparado. à espera que o GitHub Actions comece a correr...', 'ok');

    // Não basta pegar "o run mais recente" — se houver dois builds a
    // disparar perto um do outro (ex: retry rápido, ou dois telemóveis a
    // usar o builder ao mesmo tempo), o mais recente podia ser o run do
    // OUTRO build. Em vez disso, só aceitamos um run cujo created_at seja
    // posterior ao instante em que ESTE dispatch foi feito (com uma margem
    // pequena para relógios ligeiramente dessincronizados entre o nosso
    // servidor e o GitHub), disparado por workflow_dispatch.
    const CLOCK_SKEW_MS = 5000;
    const dispatchThreshold = dispatchedAt - CLOCK_SKEW_MS;
    let runId = null;
    for (let attempts = 0; attempts < 20 && !runId; attempts++) {
      await sleep(2000);
      const runsRes = await ghApi(`/repos/${owner}/${repoName}/actions/workflows/build-apk.yml/runs?event=workflow_dispatch&per_page=10`, {}, token);
      const runsJson = await runsRes.json().catch(() => ({}));
      const candidates = (runsJson.workflow_runs || [])
        .filter((r) => new Date(r.created_at).getTime() >= dispatchThreshold)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); // o mais antigo primeiro = o mais próximo do nosso dispatch
      if (candidates.length) runId = candidates[0].id;
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
      await sleep(4000);
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
// body: { repo: "owner/repo", appName, packageId, mode: "url"|"file"|"zip"|"decompiled",
//         outputFormat?: "apk"|"aab" (default "apk"; "decompiled" só aceita "apk"),
//         liveUrl?: "https://...", files: [{path, base64}], iconBase64?,
//         removeIcon?: boolean — true quando o utilizador quer voltar ao ícone
//         padrão do Capacitor (apaga resources/icon.png do repo); ignorado
//         se iconBase64 também vier preenchido,
//         splashColor?: "#RRGGBB" (default "#FDE2DD") — cor de fundo do splash screen,
//         decompiledZipBase64?: string — obrigatório em mode "decompiled": um
//         .zip (base64) com a estrutura direta de "apktool d" (AndroidManifest.xml,
//         res/, smali/ na raiz do zip),
//         keepOriginalPackage?: boolean (default true) — só relevante em mode
//         "decompiled": false faz o workflow renomear o package (manifesto +
//         pastas smali/ + referências) para o packageId enviado,
//         forceNewKeystore?: boolean (default false) — ignora o KEYSTORE_BASE64
//         fixo, mesmo que exista, e assina com uma keystore gerada só para este build }
// - Requer header x-api-key (ver APK_BUILDER_API_KEY no topo do ficheiro).
// - O token do GitHub já não vem no body — lê-se de process.env.GITHUB_TOKEN.
// - mode "url": liveUrl obrigatório, files é ignorado (não é preciso embutir nada).
// - mode "file"/"zip": files obrigatório (o front-end já resolveu ambos para a mesma forma).
// - mode "decompiled": decompiledZipBase64 obrigatório; files/iconBase64/liveUrl ignorados.
router.post('/start', express.json({ limit: '100mb' }), (req, res) => {
  const {
    repo, appName, packageId, mode, liveUrl, files, iconBase64, outputFormat,
    splashColor, removeIcon, decompiledZipBase64, keepOriginalPackage, forceNewKeystore,
  } = req.body || {};
  const effectiveMode = mode === 'url' ? 'url' : (mode === 'decompiled' ? 'decompiled' : 'file');
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
  } else if (effectiveMode === 'decompiled') {
    if (!decompiledZipBase64 || typeof decompiledZipBase64 !== 'string') {
      return res.status(400).json({ error: 'modo decompiled requer decompiledZipBase64 (zip com a saída direta de "apktool d").' });
    }
    if (effectiveFormat === 'aab') {
      return res.status(400).json({ error: 'modo decompiled só produz APK — o apktool reconstrói um APK, não um App Bundle. Usa outputFormat: "apk".' });
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
  runBuild(job, {
    owner, repoName, token: GITHUB_TOKEN, appName, packageId, mode: effectiveMode, liveUrl,
    files: files || [], iconBase64, outputFormat: effectiveFormat, splashColor, removeIcon: !!removeIcon,
    decompiledZipBase64, keepOriginalPackage: keepOriginalPackage !== false, forceNewKeystore: !!forceNewKeystore,
  });
});

// GET /api/apk-build/:id
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job não encontrado (pode ter expirado).' });
  res.json({ status: job.status, log: job.log, downloadUrl: job.downloadUrl, outputFormat: job.outputFormat });
});

module.exports = router;
