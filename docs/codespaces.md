# Configurer un essai dans GitHub Codespaces

Une page Feed Studio déjà ouverte sur une adresse `https://…-3000.app.github.dev` est servie par votre Codespace. Pour cet essai, vous n’avez pas besoin de publier une autre copie sur Render ni d’installer Node sur votre ordinateur Windows.

## Si les connexions sont désactivées

Le message « Les connexions Canva et Google doivent être activées par l’administrateur de cet outil » signifie que le processus qui sert cette page n’a pas reçu les deux configurations OAuth complètes. Les valeurs saisies dans une autre machine ne sont pas transférées par un push GitHub.

1. Placez le fichier privé `.env` à la racine du projet **dans l’éditeur Codespaces**, au même niveau que `package.json`.
2. Si vous avez reçu une archive privée contenant `.env`, extrayez-la sur votre ordinateur puis glissez uniquement `.env` dans cet emplacement. L’archive et le fichier de configuration ne doivent pas être publiés sur GitHub ; les noms prévus sont ignorés par `.gitignore`.
3. Dans le terminal où tourne le serveur, appuyez sur **Ctrl+C**, puis exécutez `npm start`.
4. Rechargez la page Feed Studio.

`npm start` charge `.env`. Les variables déjà injectées dans le processus restent prioritaires : une ancienne valeur définie dans les paramètres Codespaces doit donc être corrigée également.

Pour préparer le fichier vous-même, copiez `.env.example` puis renseignez ces variables, sans publier leurs valeurs :

```dotenv
PUBLIC_ORIGIN=https://VOTRE-CODESPACE-3000.app.github.dev
FEED_STUDIO_HOST=0.0.0.0
FEED_STUDIO_PORT=3000
CANVA_CLIENT_ID=
CANVA_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
```

Remplacez l’origine d’exemple par l’adresse exacte de votre page, sans chemin. Si vous utilisez les secrets Codespaces à la place d’un fichier local, configurez les mêmes noms dans les paramètres GitHub et redémarrez le Codespace pour qu’ils soient injectés.

## Enregistrer les deux URL de retour

Dans [Canva Integrations](https://www.canva.com/developers/integrations), enregistrez l’adresse de votre application suivie de `/oauth/callback/canva`. Activez le scope `design:content:read`.

Dans [Google OAuth Clients](https://console.cloud.google.com/auth/clients), ouvrez le client Web et ajoutez l’adresse de votre application suivie de `/oauth/callback/google` dans les **Authorized redirect URIs**.

Les URL doivent correspondre exactement à l’origine configurée dans `PUBLIC_ORIGIN`. Si vous recréez le Codespace et que son adresse change, mettez à jour ces trois réglages.

Vérifiez dans le projet Google que Drive API et Docs API sont activées et que votre compte figure parmi les utilisateurs de test si le consentement OAuth est en mode Testing.

## Essayer le feed

Cliquez sur **Connecter Canva**, puis **Connecter Google**, et acceptez les autorisations. Vous pouvez ensuite importer le lien Canva et créer le Google Doc avec les images. La génération des captions requiert du crédit OpenAI API ; `insufficient_quota` indique que cette étape reste bloquée par le quota ou la facturation API.

Le mode Codespaces est un environnement de développement : son arrêt coupe le serveur et efface les sessions en mémoire. Les Google Docs créés restent dans Drive.
