# Lancer Feed Studio dans GitHub Codespaces

Si votre page utilise une adresse `https://…-3000.app.github.dev`, elle tourne déjà dans votre Codespace. Aucun déploiement Render ni installation Windows n’est nécessaire.

## Mettre à jour puis démarrer

Dans le terminal où tourne l’ancienne version, appuyez sur **Ctrl+C**, puis lancez :

```sh
git pull --ff-only origin main
npm start
```

Pour les démarrages suivants, `npm start` suffit. Il reconstruit la page et charge le fichier privé `.env`. Aucune dépendance npm n’est à installer. Utilisez Node.js 24.5 ou plus récent ; `.nvmrc` indique la version validée.

Ouvrez le port **3000** depuis l’onglet **Ports** de Codespaces. Gardez le terminal ouvert pendant l’utilisation.

## Conserver les connexions existantes

Conservez votre `.env` à la racine du projet, à côté de `package.json`. Git ne le remplace pas et ne le publie pas. Seules ces quatre valeurs sont nécessaires :

Si vous ne pouvez pas télécharger votre configuration privée, lancez `npm run setup` dans le terminal du projet. L’assistant demande ces quatre valeurs, masque la saisie et conserve les autres réglages de `.env`. Il ne contacte aucun service externe. Retrouvez les valeurs dans vos informations OAuth existantes ; aucune clé n’est téléchargée depuis GitHub. Ensuite, lancez `npm start`.

```dotenv
CANVA_CLIENT_ID=
CANVA_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Les valeurs privées d’une autre machine ne sont pas transférées par un push GitHub. Si les connexions apparaissent comme non configurées, complétez ce fichier à partir de `.env.example`, puis redémarrez avec `npm start`. Les variables déjà injectées par Codespaces restent prioritaires. Aucune clé d’IA n’est utilisée.

L’adresse publique est détectée à partir du Codespace et du port. Si votre `.env` contient `PUBLIC_ORIGIN`, cette valeur reste prioritaire : elle doit être exactement l’adresse principale actuelle, sans chemin. Une ancienne adresse peut provoquer **Unexpected request origin**. Corrigez-la, redémarrez, puis reconnectez les comptes.

## Autorisations des comptes — une fois

Dans [Canva Integrations](https://www.canva.com/developers/integrations), ouvrez l’intégration correspondant au Client ID. Dans **Outside Canva → Configuration**, activez **Canva REST APIs** et le scope `design:content:read`. Enregistrez comme Redirect URL votre adresse principale suivie de :

```text
/oauth/callback/canva
```

Si Canva affiche `invalid_scope`, activez ce scope dans cette même intégration, sauvegardez, puis relancez **Connecter Canva** depuis l’application.

Dans le projet Google du client OAuth, activez **[Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)** et **[Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)**. Google Docs API n’est pas nécessaire : le document est créé par conversion via Drive.

Dans [Google OAuth Clients](https://console.cloud.google.com/auth/clients), ouvrez votre client **Web application**. Ajoutez comme Authorized redirect URI votre adresse principale suivie de :

```text
/oauth/callback/google
```

Le scope Google reste `drive.file`, limité aux fichiers créés par l’application. Si votre application est en mode Testing, ajoutez votre adresse aux [utilisateurs de test](https://console.cloud.google.com/auth/audience). Le message « Google n’a pas validé cette application » concerne ce statut de test ; continuez uniquement pour votre propre application et votre compte de test.

Si vous recréez le Codespace et que son adresse change, actualisez les deux URL de retour et toute valeur `PUBLIC_ORIGIN` explicite.

## Utiliser le planning

1. Connectez Canva et Google.
2. Collez le lien Canva, avec une photo par page, choisissez le nom et l’ordre, puis créez le planning.
3. Ouvrez le Google Sheet créé. Chaque ligne contient le lien privé vers sa photo ; remplissez **Caption** et **Hashtags**.
4. Revenez dans Feed Studio, actualisez les textes, puis créez le Google Doc.

Les PNG originaux, le Sheet et les Docs restent dans un dossier privé de votre Drive. Le serveur ne génère aucun texte et ne publie rien sur Instagram.

Après un redémarrage, reconnectez Google, choisissez **Reprendre un planning** et collez le lien du Sheet. Canva n’est pas nécessaire pour reprendre un planning existant. Un export identique retrouve le Doc ; des textes modifiés créent une nouvelle version sans remplacer les anciennes.

Le Codespace doit rester actif pour utiliser l’application. Ses sessions en mémoire ne survivent pas à un arrêt ; vos fichiers Google restent enregistrés.
