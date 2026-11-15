# Serveur de lecture (manuscrit et imprimé) — auto-hébergé

Tesseract, sur le téléphone, ne lit correctement que l'imprimé. Pour l'écriture manuscrite, l'application envoie la photo
à **votre propre serveur**. Celui-ci fait tourner un modèle de vision open source et corrige la lecture avec des bases
d'adresses ouvertes.

```
téléphone ──(JPEG + jeton Supabase, HTTPS)──► API (server/index.mjs)
                                                │ 1. modèle de vision (Ollama : Qwen2.5-VL…) : lit l'adresse du destinataire
                                                │    avec, comme indice, la liste des localités desservies
                                                │ 2. répertoire : BeST Address + bpost + OpenStreetMap + tableau des tournées
                                                │    → code postal, localité et rue officiels, numéro existant ?
                                                │ 3. si plusieurs rues réelles restent proches : 2e passage du modèle,
                                                │    qui regarde l'image en choisissant parmi ces rues
téléphone ◄──────── { num, street, cp, city, manuscrit, corrections } ─┘ → match() → tournée
```

Sans réseau ou si le serveur ne répond pas, l'application revient automatiquement à Tesseract sur le téléphone.

## Matériel
| Modèle (Ollama)  | Mémoire GPU | Remarque |
|------------------|-------------|----------|
| `qwen2.5vl:7b` (défaut) | ~6–8 Go | Bon compromis ; lit bien le manuscrit français |
| `qwen2.5vl:3b`   | ~4 Go       | Plus rapide, moins précis sur le manuscrit difficile |
| `qwen2.5vl:32b`  | ~24 Go      | Le plus précis |

Sans GPU, ça marche aussi, mais comptez plusieurs dizaines de secondes par lettre. Tout serveur compatible
avec l'API OpenAI (`/v1/chat/completions` avec images) convient : Ollama, vLLM, llama.cpp, LM Studio. Changez
`VISION_URL` et `VISION_MODEL`.

## Vitesse
Mesuré sur une RTX 5080 avec `qwen2.5vl:7b`, sur des lettres de synthèse : environ **0,4 s par lettre**, modèle déjà chargé.

- Le temps dépend surtout de la longueur de la réponse du modèle. La consigne demande donc une réponse courte
  (clés d'une lettre, sans transcription), contrainte par un schéma JSON.
- Le serveur charge le modèle au démarrage et le garde en mémoire (`VISION_KEEPALIVE_MIN`, 4 min par défaut).
  Sans cela, la première lettre après une pause attend le rechargement, soit plusieurs secondes.
- La taille de l'image compte peu : 1600 px au lieu de 1280 px coûte environ 40 ms.
- Chaque lecture est journalisée avec le détail des temps et des jetons, sans l'adresse ni l'image.

## Installation (Docker)
1. Sur le serveur, avec un nom de domaine qui pointe vers lui (ports 80/443 ouverts) :
   ```bash
   cd server
   cp .env.example .env        # DOMAIN, ALLOWED_ORIGINS, SUPABASE_URL, SUPABASE_ANON_KEY
   docker compose up -d
   docker compose exec ollama ollama pull qwen2.5vl:7b
   ```
   Sans GPU NVIDIA, supprimez le bloc `deploy:` du service `ollama` dans `docker-compose.yml`.
2. Construisez le répertoire d'adresses (voir ci-dessous) dans `server/data/gazetteer.json`, puis `docker compose restart api`.
3. Vérifiez : `https://ocr.exemple.be/health` doit répondre `"ok": true`.
4. Côté application : variable GitHub `OCR_SERVER_URL=https://ocr.exemple.be` (ou dans `.env` en local), puis redéployez.

Sans Docker : installez Ollama et Node ≥ 20, puis lancez `npm run server`, qui lit `server/.env`. Placez un proxy HTTPS devant.

## Bases d'adresses ouvertes
Limitez-vous aux codes postaux de vos tournées (`--cp`) : la correction est plus juste et le fichier reste petit.

| Base | Licence | Téléchargement |
|------|---------|----------------|
| **BeST Address** (BOSA) | CC-BY 4.0 | <https://opendata.bosa.be/> → `openaddress-be.zip`, à décompresser (`openaddress-bewal.csv`, `-bevlg.csv`, `-bebru.csv`) |
| **Codes postaux bpost** | libre | site de bpost, page « liste des codes postaux » → fichier Excel, à enregistrer en CSV (colonnes code postal ; localité) |
| **OpenStreetMap** | ODbL | téléchargé automatiquement via l'API Overpass (`--osm`) |
| **Votre tableau** | — | lu en direct dans Supabase par le serveur (rafraîchi toutes les 10 min), y compris les plages apprises |

```bash
npm run gazetteer -- --cp 5500,5501,5502,5503 --best openaddress-bewal.csv --bpost zipcodes_fr.csv --osm
```

Relancez l'import de temps en temps (nouvelles rues). Chaque correction est affichée au facteur, par exemple
« ✎ Rue « rue grnade » → « Rue Grande » (80 %, BeST) ». Il peut ainsi juger si la correction est juste.

## L'outil s'améliore avec l'usage
- Chaque tournée **apprise** par un facteur ajoute une rue au tableau, et donc au répertoire du serveur, au prochain rafraîchissement.
- Les localités desservies sont données au modèle comme indice, ce qui aide à déchiffrer une écriture difficile.
- Pour aller plus loin : mesurez avec `bench.html`, puis essayez un modèle plus gros. Vous pouvez aussi affiner (*fine-tune*)
  le modèle sur des jeux de données manuscrites ouverts (IAM, RIMES pour le français). Les photos de vos lettres ne
  sont pas conservées : il faudrait les collecter à part, avec un accord explicite.

## Sécurité et vie privée
- Seuls les facteurs connectés peuvent appeler le serveur : leur jeton Supabase est vérifié à chaque appel (cache de 5 min).
  `ALLOWED_ORIGINS` limite les appels à l'adresse de l'application, et le débit est limité par utilisateur (`RATE_PER_MINUTE`).
- Les images sont traitées **en mémoire uniquement**. Elles ne sont jamais écrites sur disque, et les journaux ne
  contiennent ni l'image ni l'adresse, seulement la durée et le nombre de corrections.
- Le modèle tourne chez vous : aucune image n'est envoyée à un tiers.
- La seule clé Supabase utilisée par le serveur est la clé `anon`, jamais la clé `service_role`.

## Serveur sur un PC à la maison, joint par un tunnel (sans nom de domaine)
Pour que l'application installée sur les téléphones (APK ou site) joigne le modèle qui tourne sur votre PC :

1. **Code d'accès** : dans `server/.env`, `ACCESS_CODE=` suivi d'un code d'au moins 12 caractères tiré au hasard.
   Ajoutez `https://localhost` (l'APK) et l'adresse du site à `ALLOWED_ORIGINS`. Ce fichier ne va jamais dans le dépôt.
2. **Tunnel** : installez [Tailscale](https://tailscale.com), connectez le PC, puis `tailscale funnel --bg 8787`.
   La première fois, Tailscale donne un lien pour autoriser Funnel. L'adresse obtenue (`https://nom-du-pc.xxxx.ts.net`)
   est fixe et en HTTPS.
3. **Démarrage** : double-cliquez sur `demarrer-serveur.bat` (Ollama, tunnel, serveur). Le PC doit rester allumé
   pendant que les facteurs scannent.
4. **Sur chaque téléphone** : bouton Réglages (roue dentée) → adresse du serveur et code d'accès → « Enregistrer et vérifier ».

Le code n'est écrit ni dans le site ni dans l'APK, qui sont publics : il n'existe que dans `server/.env` et dans les
réglages de chaque téléphone. Dix essais ratés par minute bloquent l'adresse qui essaie. Pour révoquer l'accès,
changez `ACCESS_CODE` et redémarrez le serveur.
