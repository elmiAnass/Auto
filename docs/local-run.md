# Tester Canva → Google Docs sur un ordinateur

Cette méthode lance le même serveur sur votre ordinateur. Elle ne demande pas de compte d’hébergement. Canva et Google doivent toujours autoriser leurs connexions ; la génération des captions utilise la facturation OpenAI API.

Le [starter officiel Canva Connect](https://github.com/canva-sdks/canva-connect-api-starter-kit#readme) utilise lui aussi des URL de retour HTTP sur `127.0.0.1` pour le développement. Utilisez exactement cette adresse et le même port dans le navigateur et les deux consoles OAuth.

## Préparer le serveur

1. Installez [Node.js](https://nodejs.org/en/download), version 24.5 ou plus récente.
2. [Téléchargez le projet](https://github.com/elmiAnass/Auto/archive/refs/heads/main.zip) et extrayez entièrement le ZIP.
3. Dans le dossier du projet, copiez `.env.example` en `.env`. Sous Windows, vérifiez que le fichier ne s’appelle pas `.env.txt`.
4. Renseignez les valeurs privées dans ce fichier :

```dotenv
PUBLIC_ORIGIN=http://127.0.0.1:3000
FEED_STUDIO_HOST=127.0.0.1
FEED_STUDIO_PORT=3000
CANVA_CLIENT_ID=
CANVA_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
```

Les valeurs privées configurées dans une autre machine ne sont pas incluses dans le ZIP GitHub. Ne publiez pas votre fichier `.env` ; Git l’ignore déjà. Aucune installation de dépendances npm n’est nécessaire.

## Enregistrer les connexions

Dans [Canva Integrations](https://www.canva.com/developers/integrations), ouvrez l’intégration correspondant au Client ID. Activez `design:content:read` et ajoutez cette Redirect URL :

```text
http://127.0.0.1:3000/oauth/callback/canva
```

Dans [Google OAuth Clients](https://console.cloud.google.com/auth/clients), ouvrez le client de type Web application et ajoutez cette Authorized redirect URI :

```text
http://127.0.0.1:3000/oauth/callback/google
```

Dans le même projet Google, activez [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) et [Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com). Si le consentement OAuth est en mode Testing, ajoutez l’adresse qui fera le test dans les utilisateurs de test. Le compte Canva doit avoir accès au design.

## Lancer le test

Ouvrez un terminal dans le dossier du projet et exécutez :

```sh
npm start
```

Gardez le terminal ouvert, puis ouvrez `http://127.0.0.1:3000` dans le navigateur **de ce même ordinateur**. Cette adresse ne permet pas d’accéder à une application qui tourne sur une autre machine, notamment dans Codex.

1. Cliquez sur **Connecter Canva**, puis **Connecter Google**, et accordez les autorisations.
2. Collez le lien Canva, choisissez l’ordre des pages, puis cliquez sur **Créer le Google Doc depuis Canva**.
3. Ouvrez le Google Doc créé et vérifiez les photos et leur ordre.
4. Choisissez le type de compte et cliquez sur **Générer les captions EN**, puis **Ajouter les captions au Google Doc**.

`insufficient_quota` indique un problème de [crédit ou de facturation OpenAI API](https://platform.openai.com/settings/organization/billing/overview). La création du Google Doc avec ses photos peut être testée sans génération IA.

Arrêtez le serveur avec **Ctrl+C**. Les sessions restent en mémoire et demandent une nouvelle connexion après un redémarrage ; les documents créés restent dans Google Drive.
