# Feed Studio — Canva → Google Docs

Collez le **lien d’un design Canva contenant une photo par page**. L’outil exporte les pages, les classe dans l’ordre de publication et crée un **Google Doc natif privé**. Choisissez ensuite le type de compte (hôtel, restaurant ou autre), préparez les captions en anglais et envoyez-les dans ce même document.

## Mise en ligne sur Render

Render peut demander une carte bancaire, même avec une instance Free. Le choix d’un Web Service manuel ne garantit pas de supprimer cette vérification. Si votre compte bloque le déploiement à cette étape, utilisez le [guide de test local](docs/local-run.md) pour tester le même serveur sur votre ordinateur, sans hébergement.

[Créer le service avec les réglages préparés](https://render.com/deploy?repo=https://github.com/elmiAnass/Auto)

Connectez votre compte Render à GitHub et confirmez le Blueprint. [render.yaml](render.yaml) prépare Node, la construction, le démarrage, l’écoute réseau et le contrôle de santé. Aucun secret n’est demandé pour ce premier déploiement : les connexions restent désactivées jusqu’à leur configuration.

Récupérez le lien HTTPS attribué par Render. Le serveur le reconnaît automatiquement via `RENDER_EXTERNAL_URL` ; `PUBLIC_ORIGIN` est facultatif sur Render et permet de choisir un domaine personnalisé.

Configurez ensuite les applications sur [Canva Integrations](https://www.canva.com/developers/integrations) et [Google Auth Platform](https://console.cloud.google.com/auth/overview). Les callbacks à enregistrer sont le lien HTTPS Render suivi de `/oauth/callback/canva` et `/oauth/callback/google`. Activez [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) et [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com). Créez un client Google de type **Web application** ; si l’application est en mode Testing, ajoutez votre adresse dans les utilisateurs de test.

Dans **Render → service → Environment**, ajoutez `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et `OPENAI_API_KEY`, puis sauvegardez et redéployez. Les secrets vont uniquement dans ces champs sécurisés. La clé OpenAI active les captions automatiques ; elle reste côté serveur. Les scopes et callbacks sont détaillés plus bas.

Ouvrez ensuite le lien Render, puis **Connecter Canva** et **Connecter Google**. Aucun déploiement Render ni accès à vos comptes n’a été effectué depuis cette conversation ; ce lien ouvre la préparation du déploiement.

## Utilisation après activation

1. Ouvrez l’application servie par le serveur Feed Studio.
2. **Connecter Canva**, puis **Connecter Google** : autorisez vos comptes une fois par session.
3. Collez le lien Canva, choisissez l’ordre dans **Votre feed**, puis **Créer le Google Doc depuis Canva**.
4. Le lien du Google Doc apparaît avec l’aperçu des photos. Choisissez maintenant hôtel, restaurant ou autre.
5. Rédigez les textes ou utilisez **Générer les captions EN**, puis **Ajouter les captions au Google Doc**.

Chaque page Canva devient une image de publication. Une maquette regroupant plusieurs photos sur une seule page ne permet pas de récupérer automatiquement ses photos originales séparées avec cette API.

### Ordre

- **Comme la maquette du feed** : pages numérotées de gauche à droite, puis de haut en bas ; publication en ordre inverse, départ en bas à droite.
- **Dans l’ordre de publication** : page 1 publiée en premier, aucune inversion.

Choisissez l’ordre avant l’import. Après création du Google Doc, cet ordre reste fixe pour que les textes correspondent aux bonnes images. **Nouveau feed** prépare un autre import sans supprimer les documents précédents.

### Captions

L’assistant facultatif reçoit chaque photo et le type de compte. Il doit écrire en anglais selon le sujet visible et les faits confirmés, sans inventer lieu précis, ingrédients, tarifs, équipements ou promotions. Ajoutez des précisions propres à une photo si nécessaire et relisez les propositions.

Avec `OPENAI_API_KEY` configurée sur le serveur, **Générer les captions EN** fonctionne directement après l’import Canva : aucune clé n’est demandée dans le navigateur. Le serveur transmet à OpenAI la photo de cet import et le brief, puis retourne uniquement le sujet, la caption et les hashtags. Le modèle est choisi par l’administrateur avec `OPENAI_MODEL` (par défaut `gpt-4.1-mini`). Les identifiants ne sont jamais intégrés au HTML ni exposés par `/api/session`.

Le clic de génération transmet les images et le brief à OpenAI, avec une facturation sur le compte API configuré, distincte d’un abonnement ChatGPT. L’import Canva seul ne lance aucune génération. Une session doit avoir connecté Canva et Google et créé son document avant d’utiliser la clé du serveur. Une génération est autorisée à la fois par session, avec trois générations simultanées au total, 120 demandes par session et 240 demandes par serveur sur une fenêtre d’une heure. Les compteurs sont en mémoire et repartent à zéro au redémarrage.

Pour l’import manuel ou la copie hors connexion, une clé personnelle peut toujours être saisie dans **Captions automatiques**. Elle reste dans la fenêtre et est envoyée directement à OpenAI, sans passer par le serveur Feed Studio.

Les champs déjà envoyés dans Google Docs ne sont plus remplacés : corrigez-les directement dans le document. Si un emplacement a été modifié dans Docs avant le premier envoi, le transfert le signale sans écraser votre texte.

## État de la version

Le serveur démarre et les parcours sont testés avec des services externes simulés. **Le lien Canva fourni dans la conversation n’a pas encore pu être importé réellement et aucun document Google n’a été créé dans le compte de l’utilisateur.** L’utilisation réelle requiert les identifiants OAuth Canva/Google, les callbacks et les autorisations des comptes. Dans l’environnement cloud Codex, les autorisations réseau enregistrées dans le brouillon doivent aussi être appliquées.

Un simple lien de partage n’accorde pas d’accès API au compte Canva. Les connexions ne sont activées dans l’interface que lorsque l’administrateur a configuré les deux applications OAuth.

## Activation par l’administrateur — une fois

Node.js **24.5 ou plus récent** ; aucune dépendance npm à installer. `index.html` est déjà construit et commité.

Configurez les valeurs dans des paramètres d’environnement sécurisés ou dans un fichier `.env` local ignoré par Git. `npm start` charge ce fichier s’il existe ; les variables injectées par l’hébergeur restent prioritaires. [.env.example](.env.example) liste les noms ; ne communiquez jamais les secrets en conversation. Un fichier local n’est pas envoyé à Render lors d’un push : renseignez les secrets séparément dans les paramètres sécurisés de l’hébergeur.

| Nom | Usage |
| --- | --- |
| `PUBLIC_ORIGIN` | Origine HTTPS publique du serveur, sans chemin ; facultatif sur Render qui fournit `RENDER_EXTERNAL_URL` |
| `CANVA_CLIENT_ID` | Identifiant de l’intégration Canva Connect |
| `CANVA_CLIENT_SECRET` | Secret de l’intégration Canva, utilisé uniquement côté serveur |
| `GOOGLE_CLIENT_ID` | Identifiant du client OAuth Google de type application Web |
| `GOOGLE_CLIENT_SECRET` | Secret du client Google, utilisé uniquement côté serveur |
| `OPENAI_API_KEY` | Clé OpenAI du serveur pour les captions des photos importées depuis Canva |
| `OPENAI_MODEL` | Modèle de génération choisi côté serveur, par défaut `gpt-4.1-mini` |

Dans l’intégration **Canva Connect**, activez le seul scope requis : `design:content:read`. Enregistrez le callback exact :

```text
PUBLIC_ORIGIN/oauth/callback/canva
```

Dans le projet Google Cloud, activez **Google Drive API** et **Google Docs API**, configurez le consentement OAuth et le client Web. Scope : `https://www.googleapis.com/auth/drive.file`, limité aux fichiers créés ou ouverts par l’application. Callback :

```text
PUBLIC_ORIGIN/oauth/callback/google
```

Remplacez `PUBLIC_ORIGIN` dans ces exemples par l’origine réelle du serveur. En développement, utilisez une origine locale et les mêmes callbacks exacts ; les comptes de test doivent être autorisés dans les applications OAuth.

Démarrage avec les variables déjà injectées ou le fichier `.env` local :

```sh
npm start
```

Avec un fichier `.env` local ignoré :

```sh
node --env-file=.env --use-env-proxy server/server.mjs
```

Le proxy réseau configuré est respecté. Le serveur écoute par défaut sur `127.0.0.1:3000`. Pour un déploiement derrière un proxy HTTPS, configurez le port/hôte nécessaires (`FEED_STUDIO_PORT`, `FEED_STUDIO_HOST`) et une `PUBLIC_ORIGIN` cohérente. Le code seul n’établit pas d’hébergement public ni de connexion aux comptes.

Vérification interne : `/healthz` doit répondre HTTP 200. `/api/session` expose uniquement l’état des connexions, leur configuration et un jeton CSRF ; aucun secret OAuth. Tant que les deux applications ne sont pas configurées, le serveur est démarré mais l’import Canva n’est pas prêt.

### Réseau requis

Canva : `canva.link`, `www.canva.com`, `canva.com`, `api.canva.com`, `export-download.canva.com`. Google : `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `docs.googleapis.com`. L’IA facultative utilise `api.openai.com` depuis le navigateur. Les destinations CDN supplémentaires éventuelles doivent être confirmées par une réponse Canva authentifiée avant ajout.

## Fonctionnement et conservation

- OAuth avec PKCE et état à usage unique ; tokens et images gardés uniquement en mémoire côté serveur, par session de navigateur. Les cookies sont HttpOnly, SameSite=Lax et Secure en HTTPS. Les mutations demandent un jeton CSRF.
- Le cookie de session expire après deux heures ; les sessions inactives sont aussi purgées et disparaissent au redémarrage. Il faut alors reconnecter les comptes. Les Google Docs déjà créés restent dans Drive.
- Les images sont intégrées dans un DOCX puis converties en Google Doc via Drive. Aucun partage public des images ni du document n’est créé par l’outil.
- Maximum 60 pages, 8 Mo par image et 40 Mo par feed ; le cache global est borné. Les téléchargements sont restreints aux hôtes Canva en HTTPS.
- L’export PNG sans perte conserve le rendu des pages Canva. Il ne récupère pas le fichier source original d’un élément photo.
- Une page A4 par publication est prévue. Captions limitées à 900 caractères, 6 lignes explicites et 5 hashtags. Vérifiez la pagination dans Google Docs après conversion et après modification du texte.
- Un nouvel import crée un nouveau document. Les modifications manuelles dans les anciens documents sont conservées. Aucun post Instagram n’est publié automatiquement.

## Développement et tests

```sh
node scripts/build.mjs
node --test tests/*.test.cjs tests/*.test.mjs
python3 tests/browser_smoke.py
```

Les tests Node vérifient les exports DOCX, OAuth, les adaptateurs et le serveur HTTP. Un test branche les vrais adaptateurs sur le serveur avec des réponses HTTP externes simulées. Les tests Chromium utilisent de vraies images et des téléchargements DOCX ; OAuth, Canva, Google et OpenAI y sont simulés. La pagination DOCX a aussi été contrôlée par conversion LibreOffice en PDF. Ces tests ne valident ni les autorisations de vos comptes ni la qualité d’une génération IA réelle.

Validation : **154 tests Node et 19 essais Chromium réussis**. Le démarrage réel du serveur, sa page et son état de connexion ont été vérifiés. `/api/session` distingue la présence des identifiants et la connexion effective des comptes ; ces états dépendent de la configuration privée et de la session en cours. La configuration automatique de l’origine Render est couverte par les tests du serveur.

Le navigateur géré ici bloque les URL `file://` ; les essais navigateur servent le même HTML par HTTP local temporaire. L’ouverture locale reste disponible uniquement pour l’import manuel et l’export Word, sans connexion Canva.

Options conservées : [guide de l’import manuel](docs/manual-workflow.md) et [version Apps Script](apps-script/README.md).
