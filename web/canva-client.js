(function (root) {
  'use strict';
  root.CanvaBridge = {attach: function (app) {
    var $ = function (id) { return document.getElementById(id); };
    var session = null, job = null, currentBusy = false;
    var marker = document.querySelector('meta[name="feed-studio-mode"]');
    var serverMode = marker && marker.content === 'server';
    var stages = {
      resolving: 'Ouverture du design Canva…', exporting: 'Export des pages Canva…',
      downloading: 'Récupération des images…', creating: 'Création du Google Doc…',
      uploading: 'Création du Google Doc…', ready: 'Google Doc créé.'
    };

    function message(text, error) {
      $('canva-status').textContent = text;
      $('canva-status').classList.toggle('error-message', Boolean(error));
    }

    async function api(path, options) {
      options = options || {};
      var headers = {'Accept': 'application/json'};
      if (options.method && options.method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        headers['X-CSRF-Token'] = session ? session.csrfToken : '';
      }
      var response;
      try {
        response = await fetch(path, {method: options.method || 'GET', credentials: 'same-origin',
          headers: headers, body: options.body ? JSON.stringify(options.body) : undefined,
          redirect: 'error', cache: 'no-store'});
      } catch (_) { throw new Error('Le serveur est inaccessible. Réessayez sans fermer cette fenêtre.'); }
      var body;
      try { body = await response.json(); } catch (_) { throw new Error('Réponse du serveur illisible.'); }
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Action impossible (HTTP ' + response.status + ').');
      return body;
    }

    function documentLink(document) {
      var url = new URL(document.url);
      if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') throw new Error('Lien Google Docs non valide.');
      $('native-document-link').href = url.href;
      $('native-document').hidden = false;
    }

    function render(busy) {
      currentBusy = busy;
      var configured = session && session.configured;
      var connected = session && session.connected;
      ['canva', 'google'].forEach(function (provider) {
        var button = $('connect-' + provider);
        var name = provider === 'canva' ? 'Canva' : 'Google';
        button.textContent = connected && connected[provider] ? name + ' connecté' : 'Connecter ' + name;
        button.disabled = busy || !configured || !configured[provider] || Boolean(connected && connected[provider]);
      });
      var both = connected && connected.canva && connected.google;
      $('canva-import').disabled = busy || !both;
      $('connection-badge').textContent = both ? 'Canva + Google connectés' : serverMode ? 'Connexion des comptes' : 'Serveur connecté nécessaire';
      $('connection-badge').classList.toggle('connected', Boolean(both));
      $('new-canva-feed').hidden = !job;
      $('new-canva-feed').disabled = busy;
      $('canva-url').disabled = busy;
      $('sync-google-doc').disabled = busy || !job || !app.getPosts().some(function (post) { return post.caption.trim() || post.hashtags.trim(); });
    }

    function restoreSynced(metadata) {
      var byId = new Map((metadata || []).map(function (post) { return [post.id, post]; }));
      app.getPosts().forEach(function (post) {
        var saved = byId.get(post.id);
        if (!saved) return;
        post.syncedCaption = saved.syncedCaption || '';
        post.syncedHashtags = saved.syncedHashtags || '';
        if (post.syncedCaption) post.caption = post.syncedCaption;
        if (post.syncedHashtags) post.hashtags = post.syncedHashtags;
      });
    }

    async function loadReadyJob(result) {
      if (!result.document || !Array.isArray(result.posts) || !result.posts.length) throw new Error('Import terminé sans document ou sans photos.');
      var prepared = [];
      try {
        for (var metadata of result.posts) {
          message('Préparation de l’aperçu : ' + (prepared.length + 1) + ' / ' + result.posts.length + '…');
          var response = await fetch('/api/jobs/' + encodeURIComponent(result.id) + '/images/' + encodeURIComponent(metadata.id),
            {credentials: 'same-origin', cache: 'no-store', redirect: 'error'});
          if (!response.ok) throw new Error('Une image importée est indisponible. Rechargez le feed.');
          var blob = await response.blob();
          var file = new File([blob], metadata.name || 'page-' + (prepared.length + 1) + '.png', {type: metadata.mime});
          var post = await app.readPhoto(file);
          post.id = metadata.id;
          post.syncedCaption = metadata.syncedCaption || '';
          post.syncedHashtags = metadata.syncedHashtags || '';
          post.caption = post.syncedCaption;
          post.hashtags = post.syncedHashtags;
          prepared.push(post);
        }
        documentLink(result.document);
        job = result;
        if (result.orderMode) $('order-mode').value = result.orderMode;
        if (result.title) $('project-title').value = result.title;
        app.replacePosts(prepared, result);
        message('Google Doc créé avec ' + prepared.length + ' photo(s). Choisissez le type de compte, préparez les captions, puis ajoutez-les au document.');
      } catch (error) {
        prepared.forEach(function (post) { URL.revokeObjectURL(post.url); });
        throw error;
      }
    }

    async function waitForJob(id) {
      for (var attempt = 0; attempt < 360; attempt++) {
        var result = await api('/api/jobs/' + encodeURIComponent(id));
        if (result.status === 'ready') { await loadReadyJob(result); return; }
        if (result.status === 'error' || result.status === 'failed') throw new Error(result.error || 'L’import Canva a échoué.');
        message(stages[result.stage] || 'Import en cours…');
        await new Promise(function (resolve) { setTimeout(resolve, 1000); });
      }
      throw new Error('Le traitement prend plus de temps que prévu. Rechargez la page pour retrouver son état.');
    }

    async function startImport() {
      if (currentBusy || !session) return;
      var link = $('canva-url').value.trim();
      if (!link) { $('canva-url').focus(); message('Collez le lien du design Canva.', true); return; }
      if (app.getPosts().length && !confirm('Créer un nouveau feed ? Le Google Doc précédent sera conservé ; les textes non envoyés de cette fenêtre seront remplacés.')) return;
      app.setBusy(true, false);
      try {
        message('Démarrage de l’import Canva…');
        var result = await api('/api/import', {method: 'POST', body: {url: link,
          orderMode: $('order-mode').value, title: $('project-title').value.trim() || 'Instagram feed'}});
        await waitForJob(result.jobId);
      } catch (error) { message(error.message, true); }
      finally { app.setBusy(false, false); }
    }

    async function syncCaptions() {
      if (currentBusy || !job) return;
      app.setBusy(true, false);
      try {
        message('Ajout des textes au Google Doc…');
        var result = await api('/api/jobs/' + encodeURIComponent(job.id) + '/captions', {method: 'POST', body: {
          posts: app.getPosts().map(function (post) { return {id: post.id, caption: post.caption.trim(), hashtags: post.hashtags.trim()}; })
        }});
        if (Array.isArray(result.posts)) restoreSynced(result.posts);
        documentLink(result.document || job.document);
        app.render();
        message('Textes envoyés au Google Doc. Vous pouvez les relire et les corriger directement dans le document.');
      } catch (error) { message(error.message, true); }
      finally { app.setBusy(false, false); }
    }

    async function init() {
      if (!serverMode) {
        message('Le lien Canva fonctionne depuis le serveur connecté de Feed Studio. Cette copie locale garde l’import manuel et l’export Word disponibles.');
        render(false);
        return;
      }
      try {
        session = await api('/api/session');
        if (!session.configured || !session.configured.canva || !session.configured.google) {
          message('Les connexions Canva et Google doivent être activées par l’administrateur de cet outil avant le premier import.', true);
        } else if (!session.connected.canva || !session.connected.google) {
          message('Connectez Canva et Google une fois, puis collez le lien du design.');
        } else {
          message('Canva et Google sont connectés. Collez le lien de votre design.');
        }
        render(false);
        if (session.latestJobId) {
          app.setBusy(true, false);
          try { await waitForJob(session.latestJobId); }
          finally { app.setBusy(false, false); }
        }
      } catch (error) { message(error.message, true); render(false); }
    }

    $('connect-canva').addEventListener('click', function () { location.assign('/oauth/start/canva'); });
    $('connect-google').addEventListener('click', function () { location.assign('/oauth/start/google'); });
    $('canva-import').addEventListener('click', startImport);
    $('sync-google-doc').addEventListener('click', syncCaptions);
    $('new-canva-feed').addEventListener('click', function () {
      if (currentBusy) return;
      if (app.getPosts().some(function (post) {
        return (post.caption && post.caption !== post.syncedCaption) || (post.hashtags && post.hashtags !== post.syncedHashtags);
      }) && !confirm('Les textes non envoyés seront retirés de cette fenêtre. Continuer ?')) return;
      job = null;
      app.replacePosts([], null);
      $('native-document').hidden = true;
      message('Collez le lien du prochain design. Le document précédent reste dans Google Drive.');
    });
    init();
    return {render: render};
  }};
}(window));
