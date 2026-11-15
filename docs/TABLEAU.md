# Tableau de tri : import par photo

L'onglet **Tableau** se remplit depuis une photo du tableau de tri affiché au bureau. Chaque ligne est lue par le
serveur de lecture (modèle de vision), vérifiée contre la base d'adresses, puis reliée à sa tournée.

## Format d'une ligne
```
5620 009 ANTHÉE RUE D' 2-146 / 1-147
│    │   │             └ plages de numéros (facultatif)
│    │   └ nom de la rue, type et article à la fin
│    └ tournée (3 chiffres)
└ code postal
```
- **Nom de rue** : remis dans l'ordre courant (« COURTILAS RUE DES » → « Rue des Courtilas »), puis remplacé par
  le nom officiel (BeST Address) quand la rue est reconnue dans ce code postal.
- **Plages** : « 2-146 » = numéros pairs de 2 à 146 ; « 1-147 » = impairs ; bornes de parités différentes
  (« 2-5 ») = tous les numéros ; « 63-63 » = ce seul numéro ; sans plage = toute la rue.
- **Lignes jaunes** : « METTET RUE DE 127 ATELIER 85 ASBL » = le seul numéro 127.
- Quand plusieurs lignes conviennent, la plage la plus étroite l'emporte (un numéro isolé passe avant une plage large).

## Comment la photo est lue
1. **Sur le téléphone** : l'application repère les colonnes du tableau grâce aux traits verticaux (trois traits
   rapprochés = bord, code postal, tournée), même si la photo est penchée, puis découpe chaque colonne en morceaux
   d'environ 28 lignes qui se recouvrent de 3 lignes.
2. **Sur le serveur** (`POST /table`) : le modèle transcrit un morceau à la fois. Il lit très bien une colonne seule ;
   devant deux colonnes il n'en lit qu'une, d'où le découpage.
3. **Assemblage** : les recouvrements sont alignés pour ne garder chaque ligne qu'une fois.

Mesure sur une photo de 4416 × 5888 px du tableau complet (9 colonnes), RTX 5080, `qwen2.5vl:7b` :
72 morceaux, environ 4 minutes.

## Lignes « à vérifier »
Elles sont placées en tête du texte et commencent par `?`. Une ligne est marquée quand :
- le code postal ou la tournée est illisible ;
- le nom de rue a dû être rapproché d'un nom officiel proche, ou n'existe nulle part dans la zone ;
- deux lectures de la même ligne (dans le recouvrement) diffèrent ;
- son code postal ou sa tournée n'apparaît presque jamais ailleurs dans le tableau.

Corrigez la ligne dans « Voir et corriger les lignes lues », retirez le `?`, puis **Enregistrer**.
Une ligne répétée en boucle par le modèle devant une zone vide est supprimée automatiquement.

## Conseils de prise de vue
- Photo d'origine du téléphone (pas une copie réduite par une messagerie) : il faut environ 20 pixels de haut par ligne.
- Bien de face, tout le tableau visible, sans reflet. Plusieurs photos peuvent être importées à la suite.

## Base partagée (Supabase)
La colonne `parity` de la table `ranges` enregistre la parité des plages. Sur un projet existant, réexécutez
`supabase/schema.sql` dans le SQL Editor : la colonne et l'index sont ajoutés sans toucher aux données.
