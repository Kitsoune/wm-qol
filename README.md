# Wiki Masters QoL – Prix du marché

Petite extension de confort pour [Wiki Masters](https://www.wiki-masters.com/) : elle **mémorise le prix moyen du marché** de tes cartes et te permet de **trier ta collection par prix**.

Aucun clic automatique, aucune vente, aucune enchère : l'extension ne fait que lire. Le scan, lancé par toi, envoie les mêmes requêtes de lecture que le site (ta collection, puis le prix moyen de chaque carte), à cadence modérée. Seules **tes** cartes sont lues : rien n'est enregistré ni affiché sur la collection d'un ami.

---

## 📥 Téléchargement

Rends-toi sur l'onglet [**Releases**](https://github.com/Kitsoune/wm-qol/releases) et télécharge la version correspondant à ton navigateur :

* **Chrome, Opera GX, Brave, Edge** : `wm-qol-chrome-vX.X.X.zip`
* **Mozilla Firefox** : `wm-qol-firefox-vX.X.X.zip` ou `wm-qol-firefox-vX.X.X.xpi`

---

## 🛠️ Installation

### 🌐 Google Chrome, Opera GX, Brave, Edge (Chromium)

1. Télécharge et **dézippe** l'archive `wm-qol-chrome-vX.X.X.zip`.
2. Ouvre la page des extensions de ton navigateur :
   * **Chrome / Brave** : tape `chrome://extensions` dans la barre d'adresse
   * **Opera GX** : tape `opera://extensions`
   * **Edge** : tape `edge://extensions`
3. Active le **Mode développeur** (interrupteur en haut à droite).
4. Clique sur **« Charger l'extension non empaquetée »** (ou glisse-dépose le dossier).
5. Sélectionne le dossier dézippé.
6. Ouvre ou rafraîchis ta page [Wiki Masters Collection](https://www.wiki-masters.com/collection) !

---

### 🦊 Mozilla Firefox

Firefox utilise une architecture différente pour les scripts d'arrière-plan (`background.scripts` au lieu de `service_worker`). Une version dédiée est donc fournie.

1. Télécharge `wm-qol-firefox-vX.X.X.zip` (ou le fichier `.xpi`).
2. Ouvre un nouvel onglet et colle dans la barre d'adresse :
   ```text
   about:debugging#/runtime/this-firefox
   ```
3. Clique sur le bouton **« Charger un module temporaire… »** (Load Temporary Add-on).
4. Sélectionne directement le fichier `.zip` ou `.xpi` téléchargé (pas besoin de le dézipper !), ou choisis le `manifest.json` à l'intérieur du dossier dézippé.
5. L'extension s'installe et s'active immédiatement.
6. Ouvre ou rafraîchis la page [Wiki Masters Collection](https://www.wiki-masters.com/collection).

> [!NOTE]
> **Remarque pour Firefox standard :** Mozilla n'autorise l'installation d'extensions non publiées sur le store officiel qu'en mode temporaire. L'extension reste active tant que Firefox est ouvert. Si tu redémarres Firefox, il te suffit de la recharger en un clic depuis `about:debugging`.

---

## 💡 Utilisation

Le bouton rond en bas à droite ouvre le panneau (raccourci : `Alt+Maj+Q`).

* **Scanner les nouvelles** (`Alt+Maj+S`) : relève le prix des cartes jamais vérifiées, avec barre de progression et temps restant. **Tout rafraîchir** relit ta collection et redemande les prix de plus de 10 min.
* **Vue → Toute la collection** : tri par prix (plus chères / moins chères), filtre par rareté, doublons seulement. Clique sur **Appliquer** : la page se recharge et le site affiche lui-même tes vraies cartes dans le nouvel ordre, toutes pages confondues. Les cartes sans prix sont placées à la fin.
* **Vue → Page affichée** : réordonne seulement les cartes à l'écran, sans rechargement.
* **Badges** : `⌀ 508` sur chaque carte dont le prix est connu, `▲`/`▼` si le prix a bougé depuis le relevé précédent, `×3` sur les doublons. Un badge grisé a plus de 7 jours.
* **Top prix / Doublons** : classements de toute la collection, avec filtre par nom.
* **Stats** : valeur du compte, moyenne, médiane, courbe d'évolution (un relevé par jour de scan), détail par rareté.
* **Réglages** : badges, prix abrégés, scan doux, panneau à gauche, surlignage des cartes au-dessus d'un prix, export CSV, effacement des prix.
* **Mémorisation manuelle** : ouvre une de tes cartes puis « Mettre aux enchères » : le prix moyen affiché est enregistré.

---

## 🧑‍💻 Développement & Compilation

Si tu souhaites cloner le dépôt et générer toi-même les packages :

```bash
npm run build
```

Les archives prêtes pour les deux navigateurs seront créées dans `dist/` :
* `dist/wm-qol-chrome-vX.X.X.zip`
* `dist/wm-qol-firefox-vX.X.X.zip`
* `dist/wm-qol-firefox-vX.X.X.xpi`

`npm test` vérifie la logique de tri et de fusion des prix (`lib.js`).
