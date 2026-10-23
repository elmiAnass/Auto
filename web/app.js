(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { session: null, job: null, busy: false, loading: true, originMismatch: false, mode: 'new', controller: null, run: 0, paused: false, message: '', action: '' };
  const POLL_INTERVAL = 1800;
  const MAX_POLL_TIME = 12 * 60 * 1000;

  class RequestError extends Error {
    constructor(message, status) { super(message); this.name = 'RequestError'; this.status = status || 0; }
  }
  class TrackingLimit extends Error {}

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function clearError() { $('app-error').hidden = true; }

  function friendlyError(error) {
    const message = String(error && error.message || '');
    if (/unexpected request origin|origin.*(?:mismatch|invalid|expected)|origine.*(?:inattendue|incorrecte)/i.test(message)) {
      return 'L’adresse ouverte ne correspond pas à celle configurée pour cette application. Utilisez le lien indiqué dans « Vos connexions », puis reconnectez vos comptes. Si vous hébergez l’application, vérifiez que son adresse publique et les adresses de retour OAuth correspondent exactement.';
    }
    if (/csrf|refresh the application/i.test(message)) return 'Votre session a changé. Rechargez cette page, puis réessayez. Votre planning reste disponible dans Google Sheets.';
    if (/failed to fetch|networkerror|network request|load failed/i.test(message)) return 'Le serveur est injoignable. Vérifiez votre connexion et que Feed Studio est démarré, puis réessayez. Votre planning reste disponible dans Google Sheets.';
    if (error && error.status === 401) return 'Votre connexion a expiré. Reconnectez Google et, pour un nouvel import, Canva, puis réessayez. Votre planning reste dans Google Sheets.';
    if (error && error.status === 404) return 'Ce planning n’est plus en mémoire sur le serveur. Utilisez « Reprendre un planning » avec son lien Google Sheets pour le retrouver.';
    return message || 'Le service n’a pas pu terminer cette action. Réessayez depuis votre planning Google Sheets.';
  }

  function showError(error, title) {
    $('error-title').textContent = title || 'L’action n’a pas abouti';
    $('error-message').textContent = friendlyError(error);
    $('enable-sheets-api').hidden = !/sheets\.googleapis\.com|Sheets API.*disabled|SERVICE_DISABLED/i.test(String(error && error.message || ''));
    $('app-error').hidden = false;
  }

  async function api(path, options) {
    options = options || {};
    const controller = new AbortController();
    const signal = options.signal;
    const abort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
    try {
      const headers = { Accept: 'application/json' };
      const init = { method: options.method || 'GET', headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal };
      if (options.body !== undefined) {
        if (!state.session || !state.session.csrfToken) throw new RequestError('Rechargez cette page pour rétablir votre session, puis réessayez.');
        headers['Content-Type'] = 'application/json';
        headers['X-CSRF-Token'] = state.session.csrfToken;
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(path, init);
      const type = response.headers.get('content-type') || '';
      if (!type.includes('application/json')) throw new RequestError('Ouvrez Feed Studio depuis l’adresse de son serveur. Cette page ne peut pas se connecter aux services lorsqu’elle est ouverte comme un fichier local.', response.status);
      const data = await response.json();
      if (!response.ok) throw new RequestError(data.error || 'Le service n’a pas pu terminer cette action. Réessayez.', response.status);
      return data;
    } catch (error) {
      if (timedOut) throw new RequestError('Le serveur met trop de temps à répondre. Réessayez le suivi ou reprenez votre planning avec son lien Google Sheets.');
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  function providerReady(provider) {
    return Boolean(state.session && state.session.configured && state.session.configured[provider] && state.session.connected && state.session.connected[provider] && !state.originMismatch);
  }

  function safeOrigin(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      return url.origin;
    } catch (_) { return null; }
  }

  function googleUrl(resource, kind) {
    if (!resource) return null;
    const section = kind === 'sheet' ? 'spreadsheets' : 'document';
    if (resource.url) {
      try {
        const url = new URL(resource.url);
        if (url.protocol === 'https:' && url.hostname === 'docs.google.com' && !url.username && !url.password && url.pathname.startsWith('/' + section + '/d/')) return url.href;
      } catch (_) { /* An invalid service URL must never become a clickable link. */ }
    }
    if (typeof resource.id === 'string' && /^[A-Za-z0-9_-]+$/.test(resource.id)) return 'https://docs.google.com/' + section + '/d/' + resource.id + '/edit';
    return null;
  }

  function setLink(id, url) {
    if (url) $(id).href = url;
    else $(id).removeAttribute('href');
  }

  function renderConnections() {
    const session = state.session;
    ['canva', 'google'].forEach((provider) => {
      const configured = Boolean(session && session.configured && session.configured[provider]);
      const connected = Boolean(session && session.connected && session.connected[provider]);
      const name = provider === 'canva' ? 'Canva' : 'Google';
      const label = $(provider + '-connection-state');
      label.textContent = name + ' · ' + (state.loading ? 'vérification' : !session ? 'indisponible' : !configured ? 'à configurer' : connected ? 'connecté' : 'non connecté');
      label.dataset.connected = String(connected && configured);
      const button = $('connect-' + provider);
      button.textContent = connected ? 'Reconnecter ' + name : 'Connecter ' + name;
      button.disabled = state.busy || state.loading || !configured || state.originMismatch;
    });
    $('connection-status').textContent = state.loading ? 'Vérification des connexions…' : !session ? 'Connexion au serveur indisponible. Rechargez la page pour réessayer.' : providerReady('canva') && providerReady('google') ? 'Tout est prêt pour créer un planning.' : providerReady('google') ? 'Vous pouvez reprendre un planning avec Google.' : 'Google est nécessaire pour enregistrer votre planning.';
    const expected = session && safeOrigin(session.publicOrigin);
    const missing = session && ['canva', 'google'].filter((provider) => !session.configured || !session.configured[provider]);
    $('configuration-notice').hidden = !state.originMismatch && !(missing && missing.length);
    $('configured-origin-link').hidden = !state.originMismatch || !expected;
    if (state.originMismatch) {
      $('configuration-title').textContent = 'Ouvrez l’adresse configurée pour Feed Studio';
      $('configuration-message').textContent = 'Cette page est ouverte sur ' + location.origin + ', mais les connexions sont configurées pour ' + expected + '. Utilisez cette adresse pour conserver la même session pendant les connexions Canva et Google. Si vous hébergez Feed Studio, faites correspondre son adresse publique et les adresses de retour OAuth.';
      setLink('configured-origin-link', expected + '/');
    } else if (missing && missing.length) {
      const names = missing.map((provider) => provider === 'canva' ? 'Canva' : 'Google').join(' et ');
      $('configuration-title').textContent = 'Connexion ' + names + ' à configurer';
      $('configuration-message').textContent = 'Cette instance ne dispose pas encore de la connexion ' + names + '. La personne qui héberge Feed Studio doit renseigner les identifiants OAuth de ce service et son adresse de retour. ' + (missing.includes('google') ? 'Google est nécessaire pour créer ou reprendre un planning.' : 'Vous pouvez déjà reprendre un planning existant avec Google.');
    }
  }

  function updateControls() {
    const hasSheet = Boolean(state.job && googleUrl(state.job.sheet, 'sheet'));
    const runningJob = Boolean(state.job && state.job.status === 'running');
    const usableJob = hasSheet && state.job.status === 'ready';
    $('create-planning').disabled = state.loading || state.busy || hasSheet || runningJob || !providerReady('canva') || !providerReady('google');
    $('resume-planning').disabled = state.loading || state.busy || runningJob || !providerReady('google');
    ['canva-url', 'project-title', 'order-mode', 'sheet-url', 'mode-new', 'mode-resume'].forEach((id) => { $(id).disabled = state.busy; });
    ['canva-url', 'project-title', 'order-mode'].forEach((id) => { $(id).disabled = state.busy || hasSheet || runningJob; });
    $('new-project').hidden = !hasSheet;
    $('new-project').disabled = state.busy || runningJob;
    $('refresh-texts').disabled = state.busy || !usableJob || !providerReady('google');
    $('export-document').disabled = state.busy || !usableJob || !providerReady('google') || !Array.isArray(state.job.posts) || !state.job.posts.length;
    $('export-requirements').hidden = !hasSheet || providerReady('google');
    $('stop-waiting').hidden = !state.busy || !state.job || state.job.status !== 'running';
    $('stop-waiting').disabled = !state.busy;
    $('continue-waiting').hidden = state.busy || !state.job || state.job.status !== 'running';
    $('create-requirements').textContent = providerReady('canva') && providerReady('google') ? 'Le planning sera enregistré dans votre Google Drive privé.' : 'Connectez Canva et Google pour créer votre planning.';
    $('resume-requirements').textContent = providerReady('google') ? 'Vos textes sont relus depuis Google Sheets.' : 'Seule la connexion Google est nécessaire.';
    renderConnections();
  }

  function setMode(mode, focus) {
    if (state.busy) return;
    state.mode = mode;
    ['new', 'resume'].forEach((name) => {
      const selected = name === mode;
      $('mode-' + name).setAttribute('aria-selected', String(selected));
      $('mode-' + name).tabIndex = selected ? 0 : -1;
      $(name + '-panel').hidden = !selected;
    });
    if (focus) $('mode-' + mode).focus();
  }

  function renderOrderHelp() {
    $('order-help').textContent = $('order-mode').value === 'GRID'
      ? 'Vos pages suivent la grille, de gauche à droite puis de haut en bas. La publication 1 sera la dernière page, en bas à droite. Le planning inversera cet ordre une seule fois.'
      : 'La page 1 sera la publication 1, puis la page 2, et ainsi de suite. Le planning conservera exactement l’ordre des pages Canva.';
  }

  function stageLabel(job) {
    const stage = typeof job.stage === 'string' ? job.stage : '';
    if (stage && /[ àâäéèêëîïôöùûüç]/i.test(stage) && !/^(export|import|resume) /i.test(stage)) return stage;
    if (/caption|text/i.test(stage)) return 'Lecture de vos derniers textes dans Google Sheets…';
    if (/document|doc(?:s)?(?:_|$)/i.test(stage)) return 'Création de votre Google Doc…';
    if (/drive|folder|sav|upload/i.test(stage)) return 'Enregistrement des photos dans votre Google Drive privé…';
    if (/sheet|spreadsheet/i.test(stage)) return job.operation === 'resume' ? 'Lecture du planning Google Sheets…' : 'Création de votre planning Google Sheets…';
    if (/image|photo|download/i.test(stage)) return 'Préparation de vos photos…';
    if (/canva/i.test(stage)) return 'Récupération des pages de votre design Canva…';
    return job.operation === 'export' ? 'Création de votre Google Doc…' : job.operation === 'resume' ? 'Lecture du planning Google Sheets…' : 'Préparation de votre planning depuis Canva…';
  }

  function progressValue(job) {
    if (job.status !== 'running') return 100;
    const stage = String(job.stage || '').toLowerCase();
    if (/document|doc|final|termin/i.test(stage)) return 88;
    if (/sheet|text|caption/i.test(stage)) return 74;
    if (/drive|folder|upload|enregistr/i.test(stage)) return 55;
    if (/image|photo|download|page/i.test(stage)) return 35;
    return 12;
  }

  function publicationNumber(post, index) {
    return Number.isInteger(post.publication) && post.publication > 0 ? post.publication : index + 1;
  }

  function renderPosts(job) {
    const posts = Array.isArray(job.posts) ? job.posts.slice().sort((a, b) => (a.publication || 0) - (b.publication || 0)) : [];
    const container = $('cards');
    container.replaceChildren();
    $('preview-section').hidden = !posts.length;
    $('photo-count').textContent = posts.length + (posts.length === 1 ? ' publication' : ' publications');
    const filled = posts.filter((post) => String(post.caption || '').trim()).length;
    $('preview-description').textContent = filled + (filled === 1 ? ' caption renseignée' : ' captions renseignées') + ' sur ' + posts.length + ' · Ordre du planning Google Sheets';
    posts.forEach((post, index) => {
      const publication = publicationNumber(post, index);
      const page = Number.isInteger(post.sourceIndex) && post.sourceIndex >= 1 ? post.sourceIndex : index + 1;
      const card = node('article', 'card');
      card.dataset.postId = String(post.id);
      const photo = node('div', 'photo-wrap');
      const image = node('img');
      image.src = '/api/jobs/' + encodeURIComponent(job.id) + '/images/' + encodeURIComponent(post.id);
      image.alt = 'Page Canva ' + page + ', publication ' + publication;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        image.hidden = true;
        if (!photo.querySelector('.image-unavailable')) photo.append(node('p', 'image-unavailable', 'Aperçu indisponible. La photo originale reste dans votre Drive privé.'));
      }, { once: true });
      photo.append(image, node('span', 'position-badge', String(publication).padStart(2, '0')));
      const body = node('div', 'card-body');
      const heading = node('div', 'card-heading');
      heading.append(node('h3', '', 'Publication ' + String(publication).padStart(2, '0')), node('span', 'page-label', 'Page Canva ' + page));
      body.append(heading);
      if (post.name) body.append(node('p', 'photo-name', post.name));
      [['caption', 'Caption'], ['hashtags', 'Hashtags']].forEach(([key, label]) => {
        const section = node('div', 'post-text');
        section.append(node('h4', '', label));
        const text = String(post[key] || '');
        section.append(node('p', text.trim() ? 'sheet-text' : 'sheet-text missing-text', text.trim() ? text : 'À compléter dans Google Sheets'));
        body.append(section);
      });
      card.append(photo, body);
      container.append(card);
    });
  }

  function renderJob() {
    const job = state.job;
    $('job-panel').hidden = !job;
    $('empty-state').hidden = Boolean(job);
    if (!job) { $('preview-section').hidden = true; return; }
    $('job-title').textContent = job.title || 'Votre planning';
    const failed = Boolean(job.error) || job.status === 'error';
    $('job-badge').textContent = failed ? 'À reprendre' : job.status === 'running' ? state.paused ? 'Suivi en pause' : 'En cours' : 'Enregistré';
    $('job-badge').dataset.kind = failed ? 'error' : job.status;
    $('job-progress').hidden = job.status !== 'running' || state.paused;
    $('progress-bar').value = progressValue(job);
    $('job-status').textContent = state.message || (failed ? 'Le traitement n’a pas abouti. Votre planning déjà enregistré reste disponible.' : job.status === 'running' ? stageLabel(job) : job.operation === 'export' && job.document ? 'Votre document a été créé à partir des derniers textes du Google Sheets.' : 'Votre planning est enregistré. Complétez ses captions et hashtags dans Google Sheets.');
    const sheetUrl = googleUrl(job.sheet, 'sheet');
    $('sheet-result').hidden = !sheetUrl;
    $('document-actions').hidden = !sheetUrl;
    setLink('open-sheet', sheetUrl);
    setLink('edit-sheet-link', sheetUrl);
    $('preview-note').hidden = !sheetUrl;
    const documentUrl = googleUrl(job.document, 'document');
    $('document-result').hidden = !documentUrl || job.documentCurrent === false || Boolean(job.error) || job.status === 'running' || job.status === 'error';
    setLink('open-document', documentUrl);
    renderPosts(job);
    updateControls();
  }

  function acceptJob(job) {
    if (!job || typeof job.id !== 'string' || !['running', 'ready', 'error'].includes(job.status)) throw new RequestError('Le serveur a renvoyé un planning incomplet. Réessayez à partir du lien Google Sheets.');
    state.job = job;
    state.message = '';
    const sheetUrl = googleUrl(job.sheet, 'sheet');
    if (sheetUrl) {
      $('sheet-url').value = sheetUrl;
      try { localStorage.setItem('feedstudio.lastSheet', sheetUrl); } catch (_) { /* Storage is optional. */ }
    }
    renderJob();
  }

  function pauseDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Suivi arrêté', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  async function pollJob(id, signal) {
    const started = Date.now();
    while (Date.now() - started < MAX_POLL_TIME) {
      const job = await api('/api/jobs/' + encodeURIComponent(id), { signal });
      if (signal.aborted) throw new DOMException('Suivi arrêté', 'AbortError');
      acceptJob(job);
      if (job.error || job.status === 'error') {
        showError(new RequestError(job.error || 'Le traitement n’a pas abouti. Réessayez depuis votre Google Sheets.'), job.operation === 'export' ? 'Le Google Doc n’a pas pu être créé' : 'Le planning n’a pas pu être chargé');
        return;
      }
      if (job.status === 'ready') return;
      await pauseDelay(POLL_INTERVAL, signal);
    }
    throw new TrackingLimit();
  }

  async function perform(action, task) {
    if (state.busy) return;
    const run = ++state.run;
    const controller = new AbortController();
    state.controller = controller;
    state.busy = true;
    state.paused = false;
    state.action = action;
    state.message = '';
    clearError();
    updateControls();
    try {
      await task(controller.signal);
    } catch (error) {
      if (run !== state.run) return;
      if (error.name === 'AbortError') return;
      if (error instanceof TrackingLimit) {
        state.paused = true;
        state.message = 'Le suivi est en pause après 12 minutes. Le traitement peut continuer sur le serveur. Reprenez le suivi ou retrouvez votre planning avec son lien Google Sheets.';
      } else {
        showError(error, action === 'export' ? 'Le Google Doc n’a pas pu être créé' : action === 'refresh' ? 'Les textes n’ont pas pu être actualisés' : undefined);
        state.message = action === 'refresh' ? 'Les textes affichés sont conservés. Corrigez le planning puis actualisez à nouveau.' : '';
        if (state.job && state.job.status === 'running') {
          state.paused = true;
          state.message = 'Le suivi a été interrompu. Le traitement peut continuer sur le serveur. Reprenez le suivi ou utilisez votre lien Google Sheets.';
        }
      }
    } finally {
      if (run === state.run) {
        state.busy = false;
        state.controller = null;
        state.action = '';
        renderJob();
        updateControls();
      }
    }
  }

  function validateUrl(input, kind) {
    let url;
    try { url = new URL(input.value.trim()); } catch (_) { input.setCustomValidity('Saisissez un lien complet commençant par https://.'); input.reportValidity(); return false; }
    const valid = url.protocol === 'https:' && !url.username && !url.password && (kind === 'sheet' ? url.hostname === 'docs.google.com' && /^\/spreadsheets\/d\/[A-Za-z0-9_-]+/.test(url.pathname) : url.hostname === 'canva.com' || url.hostname.endsWith('.canva.com') || url.hostname === 'canva.link');
    input.setCustomValidity(valid ? '' : kind === 'sheet' ? 'Saisissez le lien du Google Sheets créé par Feed Studio.' : 'Saisissez un lien de design Canva (canva.com ou canva.link).');
    if (!valid) input.reportValidity();
    return valid;
  }

  $('new-planning-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || !providerReady('canva') || !providerReady('google') || !validateUrl($('canva-url'), 'canva')) return;
    const title = $('project-title').value.trim();
    if (!title) { $('project-title').setCustomValidity('Donnez un nom à votre planning.'); $('project-title').reportValidity(); return; }
    perform('import', async (signal) => {
      const result = await api('/api/import', { method: 'POST', body: { url: $('canva-url').value.trim(), title, orderMode: $('order-mode').value }, signal });
      if (!result || typeof result.jobId !== 'string') throw new RequestError('Le serveur n’a pas retourné de planning. Réessayez.');
      acceptJob({ id: result.jobId, status: 'running', title, operation: 'import', orderMode: $('order-mode').value, posts: [] });
      await pollJob(result.jobId, signal);
    });
  });

  $('resume-planning-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || !providerReady('google') || !validateUrl($('sheet-url'), 'sheet')) return;
    perform('resume', async (signal) => {
      const result = await api('/api/resume', { method: 'POST', body: { sheetUrl: $('sheet-url').value.trim() }, signal });
      if (!result || typeof result.jobId !== 'string') throw new RequestError('Le serveur n’a pas retourné de planning. Réessayez.');
      acceptJob({ id: result.jobId, status: 'running', title: 'Votre planning', operation: 'resume', posts: [] });
      await pollJob(result.jobId, signal);
    });
  });

  $('refresh-texts').addEventListener('click', () => {
    if (!state.job || !providerReady('google')) return;
    const id = state.job.id;
    perform('refresh', async (signal) => {
      state.message = 'Actualisation des captions et hashtags depuis Google Sheets…';
      renderJob();
      const job = await api('/api/jobs/' + encodeURIComponent(id) + '/refresh', { method: 'POST', body: {}, signal });
      acceptJob(job);
      if (job.error || job.status === 'error') { showError(new RequestError(job.error || 'Le planning n’a pas pu être actualisé.')); return; }
      state.message = 'Les textes de Google Sheets sont à jour dans l’aperçu.';
    });
  });

  $('export-document').addEventListener('click', () => {
    if (!state.job || !providerReady('google')) return;
    const id = state.job.id;
    perform('export', async (signal) => {
      state.message = 'Lecture des derniers textes et préparation du Google Doc…';
      renderJob();
      const result = await api('/api/jobs/' + encodeURIComponent(id) + '/export', { method: 'POST', body: {}, signal });
      if (!result || typeof result.jobId !== 'string') throw new RequestError('Le serveur n’a pas retourné de suivi pour ce document. Reprenez votre planning Google Sheets avant de réessayer.');
      acceptJob({ ...state.job, id: result.jobId, status: 'running', operation: 'export', error: undefined });
      await pollJob(result.jobId, signal);
    });
  });

  $('stop-waiting').addEventListener('click', () => {
    if (!state.controller) return;
    ++state.run;
    state.controller.abort();
    state.controller = null;
    state.busy = false;
    state.paused = true;
    state.message = 'Le suivi est arrêté dans cette page. Le traitement peut continuer sur le serveur. Vous pouvez reprendre le suivi ou retrouver votre planning avec son lien Google Sheets.';
    renderJob();
    updateControls();
  });

  $('continue-waiting').addEventListener('click', () => {
    if (!state.job) return;
    const id = state.job.id;
    perform('tracking', (signal) => pollJob(id, signal));
  });

  ['canva', 'google'].forEach((provider) => {
    $('connect-' + provider).addEventListener('click', () => {
      if (!state.busy && state.session && state.session.configured[provider] && !state.originMismatch) location.assign('/oauth/start/' + provider);
    });
  });
  ['new', 'resume'].forEach((mode) => {
    $('mode-' + mode).addEventListener('click', () => setMode(mode));
    $('mode-' + mode).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setMode(event.key === 'Home' ? 'new' : event.key === 'End' ? 'resume' : mode === 'new' ? 'resume' : 'new', true);
    });
  });
  ['canva-url', 'sheet-url', 'project-title'].forEach((id) => $(id).addEventListener('input', () => $(id).setCustomValidity('')));
  $('order-mode').addEventListener('change', renderOrderHelp);
  $('dismiss-error').addEventListener('click', clearError);
  $('new-project').addEventListener('click', () => {
    if (state.busy || state.job && state.job.status === 'running') return;
    state.job = null;
    state.message = '';
    $('canva-url').value = '';
    $('project-title').value = 'Mon planning Instagram';
    clearError();
    setMode('new');
    renderJob();
    updateControls();
    $('canva-url').focus();
  });
  window.addEventListener('pagehide', () => { if (state.controller) state.controller.abort(); });

  async function initialize() {
    renderOrderHelp();
    const marker = document.querySelector('meta[name="feed-studio-mode"]');
    if (!marker || marker.content !== 'server') {
      state.loading = false;
      showError(new RequestError('Démarrez Feed Studio avec npm start, puis ouvrez l’adresse du serveur. Cette copie téléchargée ne peut pas connecter vos comptes.'), 'Ouvrez Feed Studio depuis son serveur');
      updateControls();
      return;
    }
    try {
      const session = await api('/api/session');
      if (!session || session.serverMode !== true || !session.csrfToken) throw new RequestError('Cette page doit être ouverte depuis le serveur Feed Studio. Démarrez le serveur, puis utilisez son adresse publique pour vous connecter.');
      state.session = session;
      const expected = safeOrigin(session.publicOrigin);
      state.originMismatch = Boolean(expected && expected !== location.origin);
      state.loading = false;
      updateControls();
      const url = new URL(location.href);
      if (url.searchParams.has('connected')) { url.searchParams.delete('connected'); history.replaceState(null, '', url.pathname + url.search + url.hash); }
      if (session.latestJobId && !state.originMismatch) {
        await perform('tracking', (signal) => pollJob(String(session.latestJobId), signal));
      } else {
        try {
          const saved = localStorage.getItem('feedstudio.lastSheet');
          const savedUrl = saved && googleUrl({ url: saved }, 'sheet');
          if (savedUrl) { $('sheet-url').value = savedUrl; setMode('resume'); }
        } catch (_) { /* Resume by pasted URL remains available. */ }
      }
    } catch (error) {
      showError(error, 'Impossible de joindre Feed Studio');
    } finally {
      state.loading = false;
      updateControls();
    }
  }

  initialize();
}());
