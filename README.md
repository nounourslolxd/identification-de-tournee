# Identification de tournée

Un facteur scanne une lettre avec son téléphone ; l'application lit l'adresse (OCR), la compare à la
base de plages d'adresses par tournée et affiche la tournée avec un score de confiance.
Tous les facteurs partagent et enrichissent la même base.

Application web installable (PWA), hébergée sur **GitHub Pages**, base partagée sur **Supabase**.
Le cahier des charges est dans [`docs/CAHIER_DES_CHARGES.md`](docs/CAHIER_DES_CHARGES.md) ;
le prototype d'origine est conservé dans [`docs/prototype-v0.1.html`](docs/prototype-v0.1.html).

## Structure

```
src/                     site statique (copié tel quel dans dist/)
  index.html, styles.css, manifest.webmanifest, sw.js
  bench.html             mesure de la précision de l'OCR sur de vraies lettres (voir docs/OCR.md)
  js/match.js            logique pure : norm, lev, sim, parseAddr, parseTable, match, recherche localité
  js/ocr.js              prétraitement d'image + Tesseract.js (auto-hébergé)
  js/reader.js           lecture via le serveur de vision (manuscrit), repli sur Tesseract
  js/board-scan.js       photo du tableau de tri → colonnes → morceaux à lire (voir docs/TABLEAU.md)
  js/scanner.js          netteté, stabilité, auto-capture, réarmement ; contrôleur caméra
  js/store.js            état + cache local (hors ligne)
  js/backend.js          couche de données : mode local ou partagé
  js/remote.js           Supabase : comptes, ranges, temps réel, file d'attente hors ligne
  js/metrics.js          calcul de précision pour bench.html
  js/ui-*.js, app.js     écrans (scanner, tableau, localité, historique, connexion)
  js/config.example.js   modèle de configuration (config.js est généré au build)
supabase/schema.sql      tables, rôles, Row Level Security
server/                  serveur de lecture auto-hébergé : modèle de vision + bases d'adresses (docs/SERVEUR-LECTURE.md)
scripts/                 vendor.mjs (copie Tesseract/Supabase), build.mjs, serve.mjs
test/                    tests unitaires (node:test)
.github/workflows/       CI + déploiement GitHub Pages
```

## Développement local

```bash
npm install              # la 1re fois ; commitez ensuite package-lock.json
npm test                 # tests unitaires, aucune dépendance à installer
cp .env.example .env     # puis renseigner SUPABASE_URL et SUPABASE_ANON_KEY
npm run dev              # build + serveur sur http://localhost:8080
```

La caméra exige HTTPS, sauf sur `localhost`.

## 1. Créer le projet Supabase

1. Créer un projet sur <https://supabase.com> (offre gratuite suffisante).
2. **SQL Editor** → coller et exécuter `supabase/schema.sql`.
3. **Project Settings → API** : noter l'URL du projet et la clé **`anon` `public`**.
   N'utilisez **jamais** la clé `service_role` dans ce dépôt.
4. **Authentication → URL Configuration** :
   - *Site URL* : `https://<utilisateur>.github.io/<depot>/`
   - *Redirect URLs* : la même adresse (et `http://localhost:8080/` pour le développement).
5. **Authentication → Email Templates → Magic Link** : ajouter le code à 6 chiffres dans le message,
   avec `{{ .Token }}`. Sur iPhone, le lien s'ouvre dans Safari et non dans l'application installée ;
   le facteur peut alors saisir le code dans l'application.
6. **Database → Replication** : vérifier que la table `ranges` est dans la publication `supabase_realtime`
   (déjà fait par `schema.sql`).
7. **Authentication → Providers → Email** : décocher *Allow new users to sign up* et inviter vos facteurs
   (*Authentication → Users → Invite user*). Sans cela, **toute personne connaissant l'adresse du site peut créer un compte
   et lire le tableau** (la clé `anon` est publique). Si vous laissez les inscriptions ouvertes, prévoyez une validation
   manuelle.
8. Se connecter une première fois dans l'application, puis promouvoir le premier administrateur
   dans le SQL Editor :
   ```sql
   update public.profiles set role = 'admin' where email = 'vous@exemple.be';
   ```

## 2. Configurer GitHub

Dépôt → **Settings → Secrets and variables → Actions → Variables** (ce ne sont pas des secrets :
la clé `anon` est publique par conception, la sécurité repose sur la RLS) :

| Variable            | Valeur                               |
|---------------------|--------------------------------------|
| `SUPABASE_URL`      | `https://xxxx.supabase.co`           |
| `SUPABASE_ANON_KEY` | clé `anon` `public`                  |
| `OCR_SERVER_URL`    | `https://ocr.exemple.be` (facultatif : serveur de lecture du manuscrit, voir `docs/SERVEUR-LECTURE.md`) |

Dépôt → **Settings → Pages → Source : GitHub Actions**.
Chaque push sur `main` lance les tests puis déploie ; les *pull requests* ne lancent que les tests.
Le build échoue si Tesseract, la langue française ou le client Supabase ne sont pas copiés dans `dist/vendor/`
ou si une clé `service_role` est détectée.

## Application Android (APK)

Chaque push sur `main` construit aussi un APK (workflow `.github/workflows/android.yml`) et le publie dans la
release **`apk`** du dépôt : téléchargez `tournees.apk` sur le téléphone puis ouvrez-le (il faut autoriser
l'installation depuis le navigateur). L'APK embarque le site (Capacitor) : il fonctionne sans GitHub Pages.

- Le projet Android est dans `android/`. Après une modification du site : `npm run build && npx cap sync android`.
- **Signature** : les secrets `KEYSTORE_B64` (fichier `.jks` en base64) et `KEYSTORE_PASSWORD` signent l'APK avec
  toujours la même clé, sinon Android refuse d'installer une mise à jour par-dessus l'ancienne version.
  Conservez le fichier `.jks` et son mot de passe : sans eux, plus de mise à jour possible sans désinstaller.
- L'APK utilise les mêmes variables que le site (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OCR_SERVER_URL`).

## Rôles

| Action                                   | Contributeur | Administrateur |
|------------------------------------------|:-----------:|:--------------:|
| Lire le tableau et les plages apprises    | ✔ | ✔ |
| Ajouter une plage apprise (`learned`)     | ✔ | ✔ |
| Supprimer **ses** ajouts                  | ✔ | ✔ |
| Modifier / supprimer le tableau de base   | ✘ | ✔ |
| Supprimer les ajouts des autres           | ✘ | ✔ |
| Promouvoir un administrateur              | ✘ | via SQL |

Ces règles sont appliquées **côté base** (RLS), pas seulement dans l'interface.

## Vie privée

Sans serveur de lecture, les photos de lettres restent sur le téléphone (miniature dans l'historique local uniquement).
Avec `OCR_SERVER_URL`, la photo part **uniquement vers votre propre serveur**, qui la traite en mémoire sans la conserver
ni la transmettre à un tiers (voir `docs/SERVEUR-LECTURE.md`).
Vers Supabase, seule l'adresse lue est envoyée, et seulement lorsque le facteur confirme un apprentissage.

## Hors ligne

Le service worker met en cache l'application, Tesseract et la langue française. Le tableau est mis en cache
dans le téléphone. Les ajouts faits sans réseau sont mis en file d'attente puis envoyés au retour de la connexion.
Les opérations d'administration (modifier le tableau) nécessitent le réseau.

## Tests

`npm test` couvre `norm`, `sim`, `parseAddr`, `parseTable`, `match` et la recherche par localité.
L'OCR n'est pas testable de façon fiable sans vraies lettres : voir « Mesurer l'OCR » dans `docs/OCR.md`.
