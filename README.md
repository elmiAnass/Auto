# Feed Studio

**Canva → Google Sheets → Google Docs.** Préparez un planning avec une photo par page Canva, rédigez les captions et hashtags dans Sheets, puis créez votre document de présentation. Cette version ne contient aucune génération IA et ne demande aucune clé OpenAI.

## Démarrer

Node.js **24.5 ou plus récent**. Aucune dépendance à installer.

```sh
npm start
```

Le démarrage reconstruit automatiquement la page et charge le fichier privé `.env`. Le terminal affiche l’adresse à ouvrir. Dans GitHub Codespaces, utilisez l’adresse du port **3000** ; le serveur retrouve automatiquement son adresse HTTPS avec les variables du Codespace. [Guide Codespaces](docs/codespaces.md).

Si une ancienne copie est déjà ouverte dans un Codespace, arrêtez-la avec **Ctrl+C**, récupérez les changements une fois avec `git pull --ff-only origin main`, puis utilisez `npm start`.

## Utiliser l’application

1. **Connectez Canva et Google.** Les autorisations restent nécessaires pour accéder à vos comptes.
2. Dans **Nouveau planning**, collez le lien Canva, donnez un nom au projet et choisissez l’ordre. Cliquez sur **Créer le planning**.
3. Ouvrez le **Google Sheets** créé. Remplissez les colonnes **Caption** et **Hashtags** ; une ligne correspond à une publication. La colonne **Photo** ouvre le PNG ou JPG enregistré dans votre Drive privé. L’application affiche aussi les aperçus.
4. Revenez dans Feed Studio. **Actualiser les textes** relit le Sheet ; **Créer le Google Doc** relit également sa dernière version et réunit photos et textes dans le bon ordre.

Les pages Canva sont exportées en PNG sans perte et leurs octets sont conservés dans Drive et le document. Chaque publication commence sur une nouvelle page. Relisez la pagination finale dans Google Docs après conversion et après toute modification manuelle.

### Reprendre plus tard

Gardez le lien du Google Sheets. Dans **Reprendre un planning**, reconnectez Google et collez ce lien. Les photos, leurs références et les textes sont retrouvés depuis Google Drive et Sheets, même après un redémarrage du serveur. Canva n’est pas nécessaire pour cette reprise.

Le planning doit avoir été créé par cette version de Feed Studio. Les feuilles ordinaires ou les onglets internes renommés ne constituent pas un planning reconnu.

### Ordre et textes

- **Comme une grille Instagram** : les pages Canva suivent la maquette de gauche à droite et de haut en bas ; la publication 1 correspond à la dernière page, en bas à droite.
- **Dans l’ordre de publication** : la page Canva 1 est la première publication.

Les colonnes **Publication**, **Page Canva** et **Photo** identifient les images. Une protection d’avertissement aide à éviter leur modification accidentelle. Le serveur vérifie les associations avant chaque export et signale la ligne à corriger.

Captions : 900 caractères et six lignes maximum. Hashtags : cinq maximum, avec lettres Unicode, chiffres ou `_`. Les champs peuvent rester vides. Aucun texte n’est inventé. Les nouvelles captions sont saisies dans Google Sheets, pas dans l’aperçu.

Un export identique réutilise le Google Doc existant. Des textes modifiés produisent une nouvelle version ; les anciennes versions et leurs modifications manuelles sont conservées.

## Configuration des comptes — une fois

Copiez `.env.example` en `.env` ou conservez votre fichier privé existant. Ce fichier est ignoré par Git. Les variables injectées par l’hébergeur restent prioritaires.

| Variable | Utilisation |
| --- | --- |
| `CANVA_CLIENT_ID` | Identifiant de l’intégration Canva |
| `CANVA_CLIENT_SECRET` | Secret Canva, uniquement côté serveur |
| `GOOGLE_CLIENT_ID` | Identifiant OAuth Google de type Web application |
| `GOOGLE_CLIENT_SECRET` | Secret Google, uniquement côté serveur |
| `PUBLIC_ORIGIN` | Adresse HTTPS publique, facultative sur Codespaces et Render |
| `FEED_STUDIO_PORT` | Port du serveur, 3000 par défaut ou valeur `PORT` de l’hébergeur |
| `FEED_STUDIO_HOST` | Hôte d’écoute ; détecté pour Codespaces et Render |

Une ancienne variable `OPENAI_API_KEY` n’est ni lue ni utilisée par cette version.

### Canva

Ouvrez [Canva Developers](https://www.canva.com/developers/integrations), sélectionnez l’intégration de votre Client ID, puis **Outside Canva → Configuration**. Activez **Canva REST APIs** et la permission **Read** de `design:content` (`design:content:read`). Ajoutez cette URL de retour, en remplaçant l’adresse d’exemple :

```text
https://VOTRE-APPLICATION/oauth/callback/canva
```

### Google

Dans le projet du client OAuth, activez **[Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)** et **[Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)**. Google Docs est créé par conversion via Drive ; cette version ne requiert pas Google Docs API.

Dans [Google OAuth Clients](https://console.cloud.google.com/auth/clients), utilisez un client **Web application** et enregistrez :

```text
https://VOTRE-APPLICATION/oauth/callback/google
```

Le seul scope Google demandé est `https://www.googleapis.com/auth/drive.file`, pour les fichiers créés par l’application. Aucun accès global à vos feuilles existantes n’est demandé. En mode **Testing**, ajoutez votre adresse aux [utilisateurs de test](https://console.cloud.google.com/auth/audience), puis acceptez les autorisations pour votre propre application.

## Conservation et limites

Les images, le planning et les documents restent privés dans votre Drive. L’application ne modifie aucune permission de partage et ne publie rien sur Instagram. Les photos sont accessibles dans Sheets par liens privés, sans dépendre de miniatures publiques temporaires.

Le planning contient un onglet caché `_FeedStudio` avec les références des images et du dernier export. Gardez-le intact pour pouvoir reprendre le travail. Les octets des photos sont vérifiés par empreinte SHA-256 lors d’une reprise.

Maximum 60 photos, 8 Mo par image, 40 Mo par feed et 25 mégapixels par image. Les sessions OAuth et les aperçus en mémoire expirent après deux heures d’inactivité ou au redémarrage. Reconnectez Google et reprenez le Sheet pour continuer ; vos fichiers Google ne dépendent pas de cette mémoire.

## Hébergement

Un Codespace déjà disponible permet cet essai sans déploiement Render. Sur Render, [le Blueprint préparé](https://render.com/deploy?repo=https://github.com/elmiAnass/Auto) configure Node, le port et la santé du serveur. Render peut demander une carte bancaire même pour son offre Free. Les secrets d’un hébergeur se configurent dans ses paramètres privés ; ils ne sont pas transférés par GitHub.

## Vérification

```sh
npm test
npm run test:browser
```

Les tests couvrent la validation des liens et des lignes, l’ordre et les images du DOCX, les adaptateurs Google/Canva, OAuth/CSRF/Origin, la reprise après redémarrage, les nouvelles versions et la récupération après échec. Les essais Chromium utilisent la vraie interface et de vraies images décodées ; les API des comptes restent simulées. Ils ne prouvent pas qu’un compte externe a autorisé l’application.

`/healthz` confirme le démarrage. `/api/session` expose seulement les états de connexion, l’origine configurée et le jeton CSRF ; aucun secret OAuth.
