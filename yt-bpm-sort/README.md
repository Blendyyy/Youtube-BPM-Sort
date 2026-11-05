# YT BPM Sort — v0.3

Extension Chrome qui affiche le **BPM et la tonalité** de chaque résultat de recherche YouTube, et permet de trier / filtrer dessus (idéal pour chercher des prods, type beats, etc.).

## Installation
1. Dézippe le dossier `yt-bpm-sort`.
2. Ouvre `chrome://extensions` et active le **Mode développeur** (en haut à droite).
3. Clique sur **Charger l'extension non empaquetée** et choisis le dossier.
   Mise à jour depuis une version précédente : remplace les fichiers, puis clique sur ⟳ sur la carte de l'extension.
4. Fais une recherche YouTube (ex. `drill type beat`) : chaque résultat affiche `140 BPM` `F#m`, et un bouton rouge **BPM** en bas à droite ouvre le panneau.

Fonctionne aussi sur Edge, Brave, Opera (même procédure).

## D'où viennent le BPM et la tonalité
Sans rien écouter, dans cet ordre :
1. **Titre** (vert)
2. **Description et tags** (bleu)
3. **Page BeatStars / Airbit / Traktrain** liée dans la description (bleu)
4. **Commentaires de l'auteur de la vidéo**, souvent le commentaire épinglé (bleu). Les commentaires des autres viewers sont ignorés.

Si rien n'est écrit nulle part : **estimation à l'écoute** (orange, `≈`) quand tu ouvres la vidéo. Le résultat est mémorisé et réapparaît ensuite dans toutes tes recherches.

Le badge BPM est plein, le badge de tonalité est en contour, dans la couleur de sa source. Survole un badge pour voir où l'info a été trouvée.

## Panneau
- Tri par BPM croissant / décroissant, plage min–max, option demi/double tempo (une prod à 70 apparaît dans une recherche 130–150)
- Filtre par **tonalité**, avec l'option « Inclure la relative » (Am ↔ C : mêmes notes)
- Masquer les vidéos sans BPM
- « Sources » : activer/désactiver la recherche en ligne, l'estimation à l'écoute, le saut d'intro

## Estimation à l'écoute
- Démarre automatiquement sur une vidéo sans BPM/tonalité écrits. Le badge devant le titre affiche la progression (`🎧 12/20 s`).
- **⚡ ×2** : passe la vidéo en ×2 le temps de l'analyse (≈10 s), puis remet ta vitesse d'avant.
- **Saut d'intro** (désactivable) : si tu es au tout début d'une vidéo de plus de 90 s, la lecture saute ~30 s plus loin. Les intros sans batterie faussent le tempo.
- Conditions : son non coupé, pas pendant les pubs. Si Chrome bloque l'audio au chargement direct d'une vidéo, le badge affiche « 🎧 clique sur la page » : un clic suffit.
- Tout est calculé dans ton navigateur, rien n'est téléchargé ni envoyé.

**Tests réalisés** sur des beats synthétiques (trap, drill, boom bap, house, lofi swingué, reggaeton, 72–160 BPM, avec bruit, nappes et voix) :
- **Tempo** : exact à ±1 BPM dans 45/45 cas, y compris en ×2.
- **Tonalité** : exacte sur les progressions typiques de beats (i-iv-VI-V, boucles trap i-VI-VII) et majeures (I-IV-V). La boucle Am-F-C-G contient les mêmes accords que C-G-Am-F : l'algo peut alors donner la relative. L'info-bulle l'indique, et l'option « Inclure la relative » du filtre couvre ce cas.

## Limites
- Les pages BeatStars/Airbit et les commentaires sont lus « à l'aveugle ». Je n'ai pas pu tester sur les vraies pages, seulement sur des pages simulées. Si une source ne remonte jamais rien chez toi, dis-le, c'est probablement un sélecteur à ajuster.
- L'estimation à l'écoute demande d'ouvrir la vidéo : YouTube ne donne pas accès au son d'une vidéo non lue.
- Morceaux sans batterie : tempo parfois non détecté (`—`). Morceaux sans harmonie claire : tonalité non affichée.
- YouTube modifie régulièrement sa page : si les badges n'apparaissent plus, il faut mettre à jour les sélecteurs dans `content.js` (constante `RENDERERS` et fonction `readRenderer`).
