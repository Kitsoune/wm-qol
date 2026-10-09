# Wiki Masters QoL – Prix du marché

Petite extension de confort pour [Wiki Masters](https://www.wiki-masters.com/) : elle **mémorise le prix moyen du marché** de tes cartes et te permet de **trier ta collection par prix**.

Elle est 100 % passive : aucun clic automatique, aucune requête ajoutée. Elle lit seulement ce que le site affiche déjà quand *tu* ouvres une carte → « Mettre aux enchères » (« MOYENNE 508 »).

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

* **Mémorisation manuelle** : Clique sur une carte puis sur « Mettre aux enchères » : dès que le prix moyen apparaît, il est enregistré.
* **Scan de collection** : Utilise le bouton de scan pour relever automatiquement les prix de toutes tes cartes de manière cadencée.
* **Badges de prix** : Dans la collection, un badge `⌀ 508` s'affiche directement sur chaque carte dont le prix est connu.
* **Tri par prix** : Dans la barre d'outils en bas à droite, clique sur le bouton **Tri par prix** (off → ▼ plus chères → ▲ moins chères). Les cartes sans prix connu sont placées à la fin.
* **Réinitialiser** : Permet de remettre à zéro les prix en cache pour rafraîchir les anciennes valeurs.

---

## 🧑‍💻 Développement & Compilation

Si tu souhaites cloner le dépôt et générer toi-même les packages :

```bash
# Génère les dossiers et archives pour Chrome & Firefox dans le dossier dist/
node build.js
# ou
npm run build
```

Les archives prêtes pour les deux navigateurs seront créées dans `dist/` :
* `dist/wm-qol-chrome-v0.8.5.zip`
* `dist/wm-qol-firefox-v0.8.5.zip`
* `dist/wm-qol-firefox-v0.8.5.xpi`
