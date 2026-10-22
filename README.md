# Feed Studio

Une interface simple pour transformer vos photos Canva en document de publications Instagram : **photo + caption en anglais + hashtags**, dans le bon ordre. Le fichier Word obtenu s’ouvre dans Google Docs.

## Commencer

1. [Téléchargez le projet](https://github.com/elmiAnass/Auto/archive/refs/heads/main.zip) et décompressez-le.
2. Ouvrez **index.html** dans Chrome, Edge ou Firefox. Aucun serveur, compte développeur ni installation n’est nécessaire.
3. Cliquez **Choisir les photos**, sélectionnez vos JPG/PNG et choisissez le type de compte : hôtel, restaurant ou autre.
4. Vérifiez l’ordre, puis cliquez **Créer le document**. Le fichier `.docx` se télécharge.
5. Pour l’ouvrir dans Google Docs : page d’accueil Docs → icône dossier → **Importer** → choisissez le `.docx`.

Commencez avec trois photos. Vous pouvez saisir les captions dans l’interface ou les compléter ensuite dans Google Docs. Les originaux restent sur votre appareil.

## Ordre du feed

- **Comme la maquette du feed** — défaut : disposez les photos de gauche à droite, puis de haut en bas. Le document commence par la dernière image, en bas à droite.
- **Dans l’ordre de publication** : la première carte devient la première publication ; aucune inversion.

Les noms sont triés naturellement à l’ajout (`01`, `02`, `10`), puis vous pouvez déplacer les cartes par glisser-déposer ou avec les flèches. Le numéro **Publication** indique l’ordre réel dans le document. Un fichier identique n’est pas ajouté deux fois, même sous un autre nom.

## Captions automatiques — optionnelles

Ouvrez **Captions automatiques**, entrez votre clé OpenAI API et, si nécessaire, le nom et les informations confirmées de la marque. Cliquez **Générer les captions EN**.

L’assistant reçoit chaque image et le type de compte : il doit adapter la caption au sujet visible et à l’activité, sans inventer équipements, tarifs, ingrédients, lieu précis ou offres. **Précisions sur cette photo** permet d’indiquer un nom de plat, un lieu confirmé ou un détail particulier. Relisez les textes avant utilisation.

- L’API est facturée sur votre compte OpenAI ; un abonnement ChatGPT ne remplace pas le crédit API.
- La clé reste en mémoire dans la fenêtre. Elle n’est ni enregistrée dans le navigateur, ni incluse dans le document, ni envoyée ailleurs qu’à `api.openai.com`.
- L’import et l’export fonctionnent hors connexion. Seul un clic sur **Générer les captions EN** transmet les images et le brief à OpenAI.
- Chaque résultat est conservé immédiatement dans la fenêtre. Si un appel échoue, corrigez le problème puis relancez : les captions déjà remplies ne sont pas remplacées. **Arrêter** interrompt la génération.
- Pour régénérer un post, effacez sa caption. Si vous changez le type de compte, les textes précédents sont conservés et doivent être revus.

## Limites et conservation

JPG/PNG uniquement, **8 Mo par photo**, **40 Mo au total**, **60 photos maximum**. Le contenu des originaux est conservé dans le fichier Word. La limite totale laisse une marge sous la limite de conversion de Google Docs.

Chaque post est prévu sur une page A4. Les textes sont limités à **900 caractères, 6 lignes explicites et 5 hashtags** pour maîtriser la pagination. Les photos sont affichées plus petites si le texte est long ; les pixels originaux ne sont pas réencodés. Contrôlez la pagination après import dans Google Docs et après vos modifications.

**Le travail n’est pas sauvegardé entre deux ouvertures.** Téléchargez votre document avant de fermer ou recharger la page. La clé API est effacée à la fermeture. Aucun post Instagram n’est publié par cet outil.

## Option avec intégration Google native

L’ancienne version Apps Script reste disponible pour travailler directement avec Drive, Sheets et Docs. Elle demande une installation et une autorisation Google : [guide avancé](apps-script/README.md).

## Développement et vérification

L’application livrée est un unique `index.html`, sans bibliothèque externe ni étape d’installation pour l’utilisateur. Sources : `web/`. Pour reconstruire après modification :

```sh
node scripts/build.mjs
node --test tests/*.test.cjs
```

Les tests navigateur nécessitent Python, Playwright, Chromium, Pillow et python-docx :

```sh
python3 tests/browser_smoke.py
```

Les tests Apps Script/API utilisent des réponses simulées. Les essais navigateur utilisent de vraies images, téléchargent le DOCX et l’ouvrent avec python-docx ; les appels IA y sont simulés. La pagination a aussi été vérifiée par conversion LibreOffice en PDF. Aucune génération IA payante ni connexion à un compte Google n’a été effectuée ici.

Résultats de cette version : **40 tests Node et 11 essais Chromium réussis**. La politique du navigateur géré dans cet environnement bloque les URL `file://` ; les essais ont donc servi le même fichier HTML par HTTP local temporaire. L’ouverture directe du fichier dans un navigateur personnel reste à confirmer. Le fichier livré inclut tout son code et ne charge aucune bibliothèque externe.
