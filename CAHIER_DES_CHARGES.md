# Identification de tournée — cahier des charges (v0.1 → vraie application)

Prototype de référence : `tri-tournees.html` (logique de correspondance, interface, auto-capture déjà écrites). À transformer en vraie application hébergée.

## But
Un facteur scanne une lettre avec son téléphone. L'application lit l'adresse, la compare à un tableau de plages d'adresses par tournée et affiche la tournée avec un score de confiance. Tous les facteurs partagent et enrichissent la même base.

## Fonctions (toutes présentes dans le prototype)
1. **Scanner** : caméra arrière, mesure de netteté (variance du laplacien) + stabilité de l'image, capture automatique, puis réarmement quand la lettre est retirée (lettre suivante).
2. **Lecture de l'adresse (OCR)** : numéro, rue, code postal, localité.
3. **Correspondance floue** : score = 50 % rue (Levenshtein normalisé, sans accents ni articles « de/la/l' »), 25 % code postal, 25 % numéro dans la plage. Vert ≥ 90 %, orange 65–90 %, rouge sinon / introuvable.
4. **Affichage par-dessus la caméra** : chaque champ en vert/orange/rouge, tournée en grand, score de confiance.
5. **Tableau** : lignes `5500 rue de l'oublie de 1 a 5 -- tournée 1`. Import par photo du tableau (OCR) puis correction manuelle.
6. **Localités** : liste `CP Localité`. Onglet de recherche par ville/village/CP → tournées + rues + plages de numéros.
7. **Historique** des lettres (miniature, adresse, tournée, score), filtre « erreurs/doutes ».
8. **Apprentissage** : si adresse inconnue/douteuse, le facteur saisit la tournée → ajout à la base partagée, utilisé en priorité ensuite.

## Ce qui change par rapport au prototype
- **Hébergement** : GitHub Pages (site statique), installable sur téléphone (PWA : manifest + service worker, cache hors ligne du tableau).
- **OCR** : Tesseract.js (langue `fra`) auto-hébergé dans le dépôt (worker, wasm, traineddata), sans appel externe. Prétraitement de l'image (niveaux de gris, contraste, recadrage du bloc d'adresse). Mesurer la précision sur de vraies lettres.
- **Base partagée** : Supabase (Postgres + Auth + Row Level Security).
  - Tables : `ranges` (cp, city, street, from_n, to_n, tournee, source: 'table'|'learned', created_by, created_at), `localities` (cp, city), `scans` (historique, optionnel, par utilisateur).
  - Rôles : tous les facteurs connectés lisent et ajoutent des `learned` ; seuls les administrateurs modifient/suppriment le tableau de base.
  - Temps réel : abonnement aux changements de `ranges`.
- **Comptes** : connexion par e-mail (lien magique) ou code d'équipe.
- Écrire des tests unitaires pour `parseAddr`, `norm`, `sim`, `match` et la recherche par localité.

## Contraintes
- Interface en français, utilisable à une main sur téléphone, gros boutons.
- Fonctionne hors ligne pour la lecture (tableau en cache) ; les ajouts se synchronisent au retour du réseau.
- Pas de clé secrète dans le dépôt (clé `anon` Supabase seulement, protégée par RLS).
- Données personnelles : les photos de lettres ne sont pas envoyées au serveur (seulement l'adresse lue, si le facteur confirme).

## Déploiement
Dépôt GitHub → GitHub Actions → GitHub Pages. Documenter dans le README la création du projet Supabase et les variables à renseigner.
