// Wiki Masters QoL — Publication directe d'une release GitHub (sans GitHub Actions)
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execSync } = require('child_process');

// 1. Construire les paquets
const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
const tag = `v${version}`;

console.log(`\n🚀 Lancement de la publication de ${tag} sur GitHub...`);

// 2. Récupérer le token Git existant
let token = '';
try {
  const creds = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n' }).toString();
  token = (creds.match(/password=(.+)/) || [])[1]?.trim();
} catch (e) {
  console.error('❌ Impossible de récupérer les identifiants Git :', e.message);
  process.exit(1);
}

if (!token) {
  console.error('❌ Aucun token GitHub trouvé dans vos identifiants Git.');
  process.exit(1);
}

function req(options, data) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function uploadAsset(releaseId, filePath) {
  const fileName = path.basename(filePath);
  const fileContent = fs.readFileSync(filePath);
  const res = await req(
    {
      hostname: 'uploads.github.com',
      path: `/repos/Kitsoune/wm-qol/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
      method: 'POST',
      headers: {
        'User-Agent': 'Node-Release-Script',
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileContent.length,
      },
    },
    fileContent
  );

  if (res.status === 201) {
    console.log(`  ✅ Attaché : ${fileName}`);
  } else {
    console.warn(`  ⚠️ Statut ${res.status} pour ${fileName} :`, res.data?.message || res.data);
  }
}

async function main() {
  // Créer ou récupérer la release
  let releaseId = null;
  const getRes = await req({
    hostname: 'api.github.com',
    path: `/repos/Kitsoune/wm-qol/releases/tags/${tag}`,
    headers: {
      'User-Agent': 'Node-Release-Script',
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (getRes.status === 200) {
    releaseId = getRes.data.id;
    console.log(`📌 Release ${tag} déjà existante (ID: ${releaseId})`);
  } else {
    const createRes = await req(
      {
        hostname: 'api.github.com',
        path: '/repos/Kitsoune/wm-qol/releases',
        method: 'POST',
        headers: {
          'User-Agent': 'Node-Release-Script',
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
      },
      JSON.stringify({
        tag_name: tag,
        name: `Wiki Masters QoL ${tag}`,
        body: `## Wiki Masters QoL ${tag}\n\n### Téléchargement :\n- **Chrome / Opera GX / Brave / Edge** : \`wm-qol-chrome-${tag}.zip\`\n- **Mozilla Firefox** : \`wm-qol-firefox-${tag}.zip\` ou \`wm-qol-firefox-${tag}.xpi\`\n\nVoir le [README](https://github.com/Kitsoune/wm-qol#installation) pour les instructions détaillées.`,
        draft: false,
        prerelease: false,
      })
    );

    if (createRes.status === 201) {
      releaseId = createRes.data.id;
      console.log(`✨ Release créée : ${createRes.data.html_url}`);
    } else {
      console.error('❌ Échec de la création de la release :', createRes.status, createRes.data);
      process.exit(1);
    }
  }

  // Uploader les 3 assets depuis dist/
  const distDir = path.join(__dirname, 'dist');
  await uploadAsset(releaseId, path.join(distDir, `wm-qol-chrome-${tag}.zip`));
  await uploadAsset(releaseId, path.join(distDir, `wm-qol-firefox-${tag}.zip`));
  await uploadAsset(releaseId, path.join(distDir, `wm-qol-firefox-${tag}.xpi`));

  console.log(`\n🎉 Tout est prêt et en ligne sur : https://github.com/Kitsoune/wm-qol/releases/tag/${tag}`);
}

main();
