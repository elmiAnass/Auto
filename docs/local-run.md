# Tester Feed Studio sur Windows

Cette méthode lance Canva → Google Sheets → Google Docs sur votre ordinateur, sans hébergement. Si vous utilisez déjà Codespaces, suivez plutôt le [guide Codespaces](codespaces.md).

## Préparer le projet

1. Installez [Node.js](https://nodejs.org/en/download), version 24.5 ou plus récente.
2. [Téléchargez le projet](https://github.com/elmiAnass/Auto/archive/refs/heads/main.zip) et extrayez entièrement le ZIP.
3. Copiez `.env.example` en `.env`, à côté de `package.json`. Vérifiez que Windows ne l’a pas nommé `.env.txt`.
4. Renseignez les quatre identifiants OAuth dans ce fichier privé :

```dotenv
CANVA_CLIENT_ID=
CANVA_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Sans réglage supplémentaire, le serveur utilise `http://127.0.0.1:3000`. Si vous conservez un ancien `.env`, retirez ou corrigez son `PUBLIC_ORIGIN` pour utiliser cette adresse locale. Aucune clé d’IA ni installation de dépendances npm n’est nécessaire. Ne publiez pas `.env` : Git l’ignore.

## Enregistrer les autorisations — une fois

Dans [Canva Integrations](https://www.canva.com/developers/integrations), ouvrez l’intégration du Client ID. Activez **Canva REST APIs**, le scope `design:content:read`, puis ajoutez cette Redirect URL :

```text
http://127.0.0.1:3000/oauth/callback/canva
```

Dans [Google OAuth Clients](https://console.cloud.google.com/auth/clients), ouvrez le client **Web application** et ajoutez cette Authorized redirect URI :

```text
http://127.0.0.1:3000/oauth/callback/google
```

Dans le même projet Google, activez **[Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)** et **[Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)**. Google Docs est créé par conversion via Drive ; Docs API n’est pas nécessaire. Si l’application est en mode Testing, ajoutez votre adresse aux [utilisateurs de test](https://console.cloud.google.com/auth/audience).

Le [starter officiel Canva Connect](https://github.com/canva-sdks/canva-connect-api-starter-kit#readme) utilise aussi les retours HTTP sur `127.0.0.1` pour le développement. Utilisez exactement la même adresse et le même port dans votre navigateur et les deux consoles OAuth.

## Démarrer et essayer

Ouvrez un terminal dans le dossier du projet :

```sh
npm start
```

Gardez le terminal ouvert et ouvrez `http://127.0.0.1:3000` dans le navigateur de ce même ordinateur.

1. Connectez Canva et Google.
2. Collez le lien d’un design avec une photo par page, choisissez le titre et l’ordre, puis créez le planning.
3. Ouvrez le Google Sheet et remplissez **Caption** et **Hashtags**. Chaque ligne donne accès à sa photo privée dans Drive.
4. Revenez dans Feed Studio, actualisez les textes et créez le Google Doc.

Arrêtez avec **Ctrl+C**. Pour continuer après un redémarrage : `npm start`, reconnectez Google et collez le lien du Sheet dans **Reprendre un planning**. Les photos, le Sheet et les documents restent dans votre Drive ; l’application n’utilise aucune IA.
