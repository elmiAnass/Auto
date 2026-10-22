# Instagram feed → Google Docs

Automatisation Google Apps Script pour les photos individuelles exportées de Canva : un dossier Google Drive en entrée, un Google Doc de travail en sortie, avec une photo, une **caption en anglais** et des **hashtags** par publication.

Le script fonctionne sans abonnement Make. La rédaction manuelle fonctionne sans clé API ; l’assistant IA facultatif analyse chaque image et tient compte du type de compte (hôtel, restaurant ou autre). Aucun post n’est publié sur Instagram.

## Installation — une seule fois

1. Créez un Google Sheet privé, puis ouvrez **Extensions → Apps Script**.
2. Remplacez `Code.gs` par le contenu de [apps-script/Code.gs](apps-script/Code.gs).
3. Dans les paramètres du projet, activez l’affichage du manifeste `appsscript.json`, puis remplacez-le par [apps-script/appsscript.json](apps-script/appsscript.json). Enregistrez.
4. Rechargez le Google Sheet. Menu **Instagram Studio → 1. Prepare sheets**, puis autorisez l’accès à Sheets, Drive et Docs.
5. Dans **Settings**, renseignez `SOURCE_FOLDER_ID` avec le lien ou l’identifiant du dossier Drive contenant les photos. `OUTPUT_FOLDER_ID` est facultatif : vide, le document est créé dans votre Drive personnel.

Les onglets `Settings` et `Feed` sont réservés à cet outil. Une structure existante différente provoque une erreur ; les données ne sont pas remplacées.

## Pour chaque feed

1. Exportez chaque photo de Canva en **JPG ou PNG**. Gardez les originaux dans Drive : le document sert à la révision, pas à récupérer les images en qualité originale.
2. Placez les photos dans un dossier dédié, sans sous-dossiers. Nommez-les `01.jpg`, `02.jpg`… ou `01 - courtyard.png` : numéros uniques, supérieurs à zéro.
3. Renseignez le dossier et le mode d’ordre dans `Settings`. Pour les captions automatiques, renseignez aussi `ACCOUNT_TYPE`, les informations confirmées et connectez l’assistant une seule fois (voir ci-dessous).
4. Choisissez **Instagram Studio → Run full workflow**, cochez l’option IA si vous souhaitez des captions, puis **Start**. L’outil importe les photos, enchaîne les lots de captions et crée le Google Doc. Gardez la fenêtre ouverte pendant le traitement ; ne modifiez pas `Feed` ou `Settings` entre-temps.
5. Ouvrez le document depuis le lien final. Relisez les captions, hashtags et la pagination. Sans IA, les textes vides deviennent des emplacements à compléter directement dans Docs.

Les actions séparées **Import photos**, **Refresh publication order**, **Draft English captions (3 at a time)** et **Create review Google Doc** restent disponibles pour contrôler chaque étape. Dans `Feed`, vous pouvez modifier les positions, ajouter **Photo facts** et corriger les captions avant l’export.

L’import conserve vos textes et positions et n’ajoute pas deux fois la même photo. Si vous fermez la fenêtre pendant le traitement, le lot en cours peut se terminer, mais les suivants ne sont pas lancés. Relancez le workflow pour reprendre : les captions existantes sont conservées.

### Ordre des photos

| `ORDER_MODE` | Le numéro `01` signifie… | Ordre du document |
| --- | --- | --- |
| `PUBLICATION` — défaut | Première photo à publier | 01, 02, 03… |
| `GRID` | Case en haut à gauche de la maquette, puis gauche → droite et haut → bas | Numéros décroissants, départ en bas à droite |

Pour la maquette fournie de **15 photos**, en mode `GRID` : **15, 14, 13… 01**. En mode `PUBLICATION`, numérotez déjà dans l’ordre de publication : aucune inversion supplémentaire. La grille finale suppose ensuite cet ordre de publication, sans réorganisation ni épinglage des posts.

Pour une autre campagne, dupliquez le Google Sheet, effacez uniquement les lignes de données de `Feed`, puis changez le dossier. Un import conserve toutes les lignes déjà présentes : ne mélangez pas deux campagnes.

## Captions selon la photo et le compte

Dans `Settings` :

- `ACCOUNT_TYPE` : `hotel`, `restaurant` ou `other` — obligatoire pour l’IA.
- `BRAND_NAME` et `BRAND_BRIEF` : facultatifs, pour préciser la marque, l’audience et la campagne.
- `TONE` : style d’écriture ; défaut élégant, chaleureux et sobre.
- `VERIFIED_DETAILS` : informations confirmées uniquement.
- `CALL_TO_ACTION` et `REQUIRED_HASHTAGS` : facultatifs.

La colonne **Photo facts** permet d’ajouter une précision propre à une image : nom d’un plat, type de chambre, etc. L’IA reçoit l’image elle-même, ces précisions et le type de compte. Elle propose un sujet reconnu et une caption en anglais, sans inventer équipements, tarifs, localisation précise ou promotions. Toute proposition reste à vérifier.

Pour activer l’IA, choisissez **Connect caption assistant** et saisissez votre clé API OpenAI dans le formulaire local. Elle est conservée dans les propriétés utilisateur Apps Script, jamais dans la feuille, le document ou les journaux. Ne la partagez pas en conversation. Réservez l’édition du projet à des personnes de confiance, qui peuvent modifier le code exécuté.

**Draft English captions** transmet les images et le brief à OpenAI ; l’utilisation de l’API est facturée sur votre compte. Aucune image n’est rendue publique. Modèle par défaut : `gpt-4.1-mini`, modifiable selon les modèles vision Responses API accessibles à votre compte.

Chaque exécution traite au maximum **3 images** et sauvegarde chaque résultat immédiatement. **Run full workflow** enchaîne automatiquement les lots tant que la fenêtre reste ouverte ; l’action séparée traite un seul lot. Une caption existante n’est jamais remplacée. Pour régénérer un post, effacez sa caption dans `Feed` ; ses anciens hashtags seront remplacés. Sans clé, import et création du document restent disponibles.

## Conservation et limites

- Les photos sources ne sont pas modifiées. Le document n’est pas rendu public par le script ; un dossier de sortie partagé peut lui transmettre ses règles de partage.
- Un export inchangé retrouve le document précédent et conserve vos modifications dans Docs. Une modification des images, de la feuille ou du dossier de sortie produit une nouvelle version ; les changements faits directement dans l’ancien document ne sont pas transférés.
- JPEG/PNG, maximum **8 Mo par image**, **60 images par document**, **5 hashtags par post**. Les fichiers non-images sont ignorés ; un format image non pris en charge est signalé.
- Une page A4 est prévue par publication, avec un saut entre les posts. Captions limitées à **900 caractères et 6 lignes explicites**. La pagination doit être vérifiée dans Google Docs, notamment après modification du texte.
- API 401 : vérifier la clé. API 429 : vérifier quota/facturation et réessayer plus tard. Les messages d’erreur ne reprennent ni la clé ni le corps de réponse du service.

## Vérification

Avec Node.js 18 ou plus récent, sans dépendances :

```sh
node --test tests/automation.test.cjs
```

Les tests utilisent des services Google/API simulés. **Ils ne prouvent pas une connexion réelle à Google ni la qualité des captions IA.** Aucune autorisation Google ni génération payante n’a été effectuée ici.

Essai réel après installation : utilisez 3 photos numérotées et lancez **Run full workflow**. Contrôlez les sujets, captions, pages et l’ordre de publication. Relancez sans changement : aucun doublon ne doit apparaître. Vérifiez aussi le mode `GRID`, puis les captions avec `ACCOUNT_TYPE=restaurant` et `hotel` sur des photos adaptées, dans deux copies distinctes de la feuille.
