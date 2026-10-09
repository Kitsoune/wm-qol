// Wiki Masters QoL — Build & Packaging Script
// Génère les packages prêts à l'emploi pour Chrome (Chromium) et Firefox dans le dossier `dist/`.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// CRC32 table & helper
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

function calculateCrc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

// Minimal, zero-dependency zip generator
function createZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const filename = file.name.replace(/\\/g, '/');
    const nameBuf = Buffer.from(filename, 'utf8');
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const crc = calculateCrc32(content);
    const compressed = zlib.deflateRawSync(content);

    // Local file header (30 bytes + filename)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    lh.writeUInt16LE(0x0800, 6);      // flag: UTF-8 filename
    lh.writeUInt16LE(8, 8);           // compression method: Deflate
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);         // extra field length
    nameBuf.copy(lh, 30);

    // Central directory header (46 bytes + filename)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE(20, 4);         // version made by
    ch.writeUInt16LE(20, 6);         // version needed
    ch.writeUInt16LE(0x0800, 8);      // UTF-8
    ch.writeUInt16LE(8, 10);          // Deflate
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);         // extra field len
    ch.writeUInt16LE(0, 32);         // comment len
    ch.writeUInt16LE(0, 34);         // disk number start
    ch.writeUInt16LE(0, 36);         // internal file attrs
    ch.writeUInt32LE(0, 38);         // external file attrs
    ch.writeUInt32LE(offset, 42);    // relative offset of local header
    nameBuf.copy(ch, 46);

    localHeaders.push(lh, compressed);
    centralHeaders.push(ch);
    offset += lh.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // start disk
  eocd.writeUInt16LE(files.length, 8);  // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // size of central directory
  eocd.writeUInt32LE(offset, 16);    // offset of central directory
  eocd.writeUInt16LE(0, 20);         // comment length

  return Buffer.concat([...localHeaders, centralBuf, eocd]);
}

function build() {
  console.log('🚀 Début de la génération des paquets Wiki Masters QoL...');

  // 1. Lire le manifest de base
  const chromeManifestPath = path.join(ROOT_DIR, 'manifest.json');
  if (!fs.existsSync(chromeManifestPath)) {
    throw new Error('manifest.json introuvable à la racine !');
  }
  const chromeManifest = JSON.parse(fs.readFileSync(chromeManifestPath, 'utf8'));
  const version = chromeManifest.version || '0.1.0';
  console.log(`📦 Version détectée : v${version}`);

  // 2. Fichiers communs à inclure
  const sharedFilenames = [
    'background.js',
    'content.js',
    'inject.js',
    'styles.css',
    'README.md',
    'LICENSE',
  ];

  const sharedFiles = [];
  for (const fname of sharedFilenames) {
    const fpath = path.join(ROOT_DIR, fname);
    if (fs.existsSync(fpath)) {
      sharedFiles.push({ name: fname, content: fs.readFileSync(fpath) });
    }
  }

  // Nettoyer / recréer le dossier dist
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const chromeDistDir = path.join(DIST_DIR, 'chrome');
  const firefoxDistDir = path.join(DIST_DIR, 'firefox');
  fs.mkdirSync(chromeDistDir, { recursive: true });
  fs.mkdirSync(firefoxDistDir, { recursive: true });

  // 3. Build Chrome / Chromium
  const chromeFiles = [
    { name: 'manifest.json', content: JSON.stringify(chromeManifest, null, 2) + '\n' },
    ...sharedFiles,
  ];

  for (const f of chromeFiles) {
    fs.writeFileSync(path.join(chromeDistDir, f.name), f.content);
  }

  const chromeZipBuffer = createZip(chromeFiles);
  const chromeZipName = `wm-qol-chrome-v${version}.zip`;
  fs.writeFileSync(path.join(DIST_DIR, chromeZipName), chromeZipBuffer);
  console.log(`✅ Package Chrome créé : dist/${chromeZipName} (${chromeZipBuffer.length} octets)`);

  // 4. Build Firefox
  // Lire ou composer le manifest Firefox
  const firefoxManifestPath = path.join(ROOT_DIR, 'manifest.firefox.json');
  let firefoxManifest;
  if (fs.existsSync(firefoxManifestPath)) {
    firefoxManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'));
    firefoxManifest.version = version; // sync version
  } else {
    firefoxManifest = {
      ...chromeManifest,
      background: {
        scripts: ['background.js'],
      },
      browser_specific_settings: {
        gecko: {
          id: 'wm-qol@kitsoune',
          strict_min_version: '128.0',
        },
      },
    };
  }

  const firefoxFiles = [
    { name: 'manifest.json', content: JSON.stringify(firefoxManifest, null, 2) + '\n' },
    ...sharedFiles,
  ];

  for (const f of firefoxFiles) {
    fs.writeFileSync(path.join(firefoxDistDir, f.name), f.content);
  }

  const firefoxZipBuffer = createZip(firefoxFiles);
  const firefoxZipName = `wm-qol-firefox-v${version}.zip`;
  const firefoxXpiName = `wm-qol-firefox-v${version}.xpi`;

  fs.writeFileSync(path.join(DIST_DIR, firefoxZipName), firefoxZipBuffer);
  fs.writeFileSync(path.join(DIST_DIR, firefoxXpiName), firefoxZipBuffer);

  console.log(`✅ Package Firefox (.zip) créé : dist/${firefoxZipName} (${firefoxZipBuffer.length} octets)`);
  console.log(`✅ Package Firefox (.xpi) créé : dist/${firefoxXpiName} (${firefoxZipBuffer.length} octets)`);
  console.log(`📂 Dossiers non empaquetés disponibles dans dist/chrome et dist/firefox`);
  console.log('🎉 Terminé avec succès !');
}

build();
