# OCR : fonctionnement et mesure

## Chaîne de lecture
1. **Capture** pleine résolution (scanner) ou photo du tableau.
2. **Prétraitement** (`src/js/ocr.js`) : réduction à 1800 px max, niveaux de gris, étirement du contraste (percentiles 2–98),
   puis, pour les lettres, **recadrage du bloc d'adresse** (masque d'encre par seuil local → bandes de lignes →
   bande la plus massive et la plus centrale). Si aucun bloc convaincant : image entière.
3. **Tesseract.js** (langue `fra`, modèle `best_int`) auto-hébergé dans `vendor/` ; PSM 6 pour une lettre, PSM 4 pour un tableau.
4. **Analyse** (`parseAddr`) puis **correspondance** (`match`).

## Mesurer la précision (à faire avant la mise en service)
Les tests unitaires vérifient le prétraitement sur des images synthétiques, **pas la précision de lecture** :
elle dépend de vos vraies lettres (enveloppes à fenêtre, écriture manuscrite, éclairage).

1. Ouvrir `bench.html` (même site, par exemple `https://…/bench.html`).
2. Choisir 30 à 100 photos de lettres représentatives, prises comme un facteur le ferait.
3. Saisir la vérité terrain : `numéro;rue;code postal;ville;tournée`, une ligne par photo, dans l'ordre alphabétique des fichiers.
4. Lire les taux par champ et le taux de **tournée correcte** ; comparer avec/sans recadrage.

Pistes si la précision est insuffisante : seuils `SHARP`/`MOVE` du scanner, paramètres `bias`/`radius` de `inkMask`,
tolérance de `gapMax` dans `findTextBlock`, modèle de langue `best` (plus précis, plus lourd) ou `fast` (plus léger).
