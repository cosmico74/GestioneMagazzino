const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const pool = require('../db');

// ============================================================
// CARICA LE VARIABILI D'AMBIENTE DAL FILE .env
// ============================================================
require('dotenv').config();

// ============================================================
// CONFIGURAZIONE GOOGLE DRIVE (da variabili d'ambiente)
// ============================================================

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');

// ============================================================
// FUNZIONE: Genera il backup SQL
// ============================================================
async function generateBackup() {
  try {
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(row => Object.values(row)[0]);

    let sql = '-- Backup del database\n';
    sql += `-- Generato il ${new Date().toISOString()}\n\n`;
    sql += 'SET FOREIGN_KEY_CHECKS = 0;\n\n';

    for (const table of tableNames) {
      const [createResult] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
      const createSQL = createResult[0]['Create Table'];
      sql += `DROP TABLE IF EXISTS \`${table}\`;\n${createSQL};\n\n`;

      const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
      if (rows.length === 0) continue;

      const columns = Object.keys(rows[0]);
      const columnNames = columns.map(c => `\`${c}\``).join(', ');

      for (const row of rows) {
        const values = columns.map(col => {
          const val = row[col];
          if (val === null) return 'NULL';
          if (typeof val === 'string') {
            return `'${val.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
          }
          if (val instanceof Date) {
            return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
          }
          if (typeof val === 'boolean') return val ? 1 : 0;
          return val;
        });
        sql += `INSERT INTO \`${table}\` (${columnNames}) VALUES (${values.join(', ')});\n`;
      }
      sql += '\n';
    }

    sql += 'SET FOREIGN_KEY_CHECKS = 1;\n';

    const fileName = `backup_${new Date().toISOString().slice(0, 10)}.sql`;
    const backupsDir = path.join(__dirname, '..', 'backups');
    const filePath = path.join(backupsDir, fileName);

    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    fs.writeFileSync(filePath, sql);
    return { filePath, fileName, sql };
  } catch (err) {
    console.error('❌ Errore generazione backup:', err);
    throw err;
  }
}

// ============================================================
// FUNZIONE: Carica su Google Drive
// ============================================================
async function uploadToDrive(filePath, fileName) {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error('❌ Variabili GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET non impostate.');
      return null;
    }

    const oAuth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    const token = getToken();
if (token) {
  oAuth2Client.setCredentials(token);
} else {
  console.log('⚠️ Token non trovato. Esegui prima il setup di autenticazione.');
  return null;
}

    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    const folderSearch = await drive.files.list({
      q: "name='Backup Database' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name)',
    });

    let folderId;
    if (folderSearch.data.files.length === 0) {
      const folder = await drive.files.create({
        resource: {
          name: 'Backup Database',
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id',
      });
      folderId = folder.data.id;
      console.log('📁 Cartella Backup creata su Drive');
    } else {
      folderId = folderSearch.data.files[0].id;
    }

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };
    const media = {
      mimeType: 'application/sql',
      body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink',
    });

    console.log(`✅ Backup caricato su Drive: ${response.data.name}`);
    console.log(`🔗 Link: https://drive.google.com/file/d/${response.data.id}/view`);

    await cleanOldBackups(drive, folderId);
    return response.data;
  } catch (err) {
    console.error('❌ Errore caricamento su Drive:', err);
    return null;
  }
}

// ============================================================
// FUNZIONE: Mantieni solo gli ultimi N backup
// ============================================================
async function cleanOldBackups(drive, folderId, keep = 5) {
  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
    });

    const files = response.data.files;
    if (files.length > keep) {
      const toDelete = files.slice(keep);
      for (const file of toDelete) {
        await drive.files.delete({ fileId: file.id });
        console.log(`🗑️ Eliminato backup vecchio: ${file.name}`);
      }
    }
  } catch (err) {
    console.warn('⚠️ Errore pulizia backup:', err.message);
  }
}

// ============================================================
// FUNZIONE: Setup autenticazione (da eseguire una volta)
// ============================================================
async function setupDriveAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Variabili GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET non impostate.');
    return false;
  }

  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
  });

  console.log('🔐 Autorizza l\'accesso a Google Drive visitando questo URL:');
  console.log(authUrl);
  console.log('\n📝 Inserisci il codice di autorizzazione:');

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Codice: ', async (code) => {
      rl.close();
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log('✅ Token salvato in:', TOKEN_PATH);
        resolve(true);
      } catch (err) {
        console.error('❌ Errore:', err.message);
        resolve(false);
      }
    });
  });
}

// ============================================================
// MAIN: Esegui backup
// ============================================================
async function runBackup() {
  try {
    console.log('🔄 Avvio backup...');
    const { filePath, fileName } = await generateBackup();
    console.log(`✅ Backup generato: ${fileName}`);
    await uploadToDrive(filePath, fileName);
  } catch (err) {
    console.error('❌ Backup fallito:', err);
  }
}

// ============================================================
// CRON JOB: Ogni domenica alle 2:00
// ============================================================
function startScheduler() {
  cron.schedule('0 2 * * 0', async () => {
    console.log('⏰ Esecuzione backup settimanale...');
    await runBackup();
  });
  console.log('✅ Scheduler avviato. Backup ogni domenica alle 2:00.');
}

// ============================================================
// FUNZIONE: Ottiene il token da variabile d'ambiente o da file
// ============================================================
function getToken() {
  // Prova a leggere da variabile d'ambiente (Render)
  if (process.env.GOOGLE_TOKEN) {
    try {
      return JSON.parse(process.env.GOOGLE_TOKEN);
    } catch (e) {
      console.warn('⚠️ Errore parsing GOOGLE_TOKEN:', e.message);
    }
  }
  
  // Fallback: leggi da file (locale)
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_PATH));
    } catch (e) {
      console.warn('⚠️ Errore lettura token.json:', e.message);
    }
  }
  
  return null;
}

// ============================================================
// ESPORTAZIONI
// ============================================================
module.exports = {
  startScheduler,
  runBackup,
  setupDriveAuth,
  generateBackup,
  uploadToDrive,
};