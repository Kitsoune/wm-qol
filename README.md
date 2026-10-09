# Wiki Masters QoL – Prix du marché

Petite extension de confort (Chrome, Opera GX, Edge, Brave…) : elle **mémorise le prix moyen du marché**
de tes cartes et te laisse **trier ta collection par prix**.

Elle est 100 % passive : aucun clic automatique, aucune requête ajoutée. Elle lit seulement ce que le site
affiche déjà quand *tu* ouvres une carte → « Mettre aux enchères » (« MOYENNE 508 »).

## Installation
1. Dézippe le dossier.
2. Ouvre `chrome://extensions` (Opera GX : `opera://extensions`), active le **mode développeur**.
3. **Charger l'extension non empaquetée** → choisis le dossier `wm-qol`.
4. Recharge la page https://www.wiki-masters.com/collection.

## Utilisation
- Clique sur une carte, puis « Mettre aux enchères » : quand le prix apparaît, il est enregistré.
- Dans la collection, un badge `⌀ 508` apparaît sur les cartes dont le prix est connu.
- Barre en bas à droite : bouton **Tri par prix** (off → ▼ plus chères → ▲ moins chères). Les cartes
  sans prix connu passent à la fin.
- « Réinitialiser » efface les prix mémorisés (les prix évoluent, pense à rafraîchir les anciens).

## Limites connues
- Je n'ai pas pu inspecter le DOM de ta page connectée : le repérage des cartes est heuristique
  (nom de carte + image dans une grille). Si les badges n'apparaissent pas ou si le tri n'a pas d'effet,
  envoie-moi le HTML d'une carte de la grille (clic droit → Inspecter) et j'ajuste.
- Le tri utilise la propriété CSS `order` : il fonctionne si la collection est en grille/flex.
