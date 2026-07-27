const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const pool = require('./db');

// ============================================================
// CONFIGURAZIONE GOOGLE DRIVE
// ============================================================

// 🔑 Devi creare un progetto su Google Cloud Console e scaricare le credenziali
// Salva il file come credentials.json nella cartella backend/
// Per maggiori informazioni: https://developers.google.com/drive/api/quickstart/nodejs

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

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
    const filePath = path.join(__dirname, 'backups', fileName);

    // Crea la cartella backups se non esiste
    if (!fs.existsSync(path.join(__dirname, 'backups'))) {
      fs.mkdirSync(path.join(__dirname, 'backups'));
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
    // Carica le credenziali
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Carica il token (se esiste)
    let token;
    if (fs.existsSync(TOKEN_PATH)) {
      token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      oAuth2Client.setCredentials(token);
    } else {
      console.log('⚠️ Token non trovato. Esegui prima il setup di autenticazione.');
      return null;
    }

    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    // Cerca una cartella "Backup" su Drive (crea se non esiste)
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
      console.log('📁 Cartella Backup creata su Drive:', folderId);
    } else {
      folderId = folderSearch.data.files[0].id;
    }

    // Carica il file
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

    console.log(`✅ Backup caricato su Drive: ${response.data.name} (ID: ${response.data.id})`);
    console.log(`🔗 Link: https://drive.google.com/file/d/${response.data.id}/view`);

    // Opzionale: elimina i backup vecchi (mantieni solo gli ultimi 5)
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
    console.warn('⚠️ Errore pulizia backup vecchi:', err.message);
  }
}

// ============================================================
// FUNZIONE: Setup autenticazione Google Drive (da eseguire una volta)
// ============================================================
async function setupDriveAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

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
        console.log('✅ Token salvato!');
        resolve(true);
      } catch (err) {
        console.error('❌ Errore ottenimento token:', err);
        resolve(false);
      }
    });
  });
}

// ============================================================
// MAIN: Esegui backup e upload su Drive
// ============================================================
async function runBackup() {
  try {
    console.log('🔄 Avvio backup settimanale...');
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
  // Programma: 0 2 * * 0 = Domenica alle 2:00
  // Per test: ogni 5 minuti usa "*/5 * * * *"
  cron.schedule('0 2 * * 0', async () => {
    console.log('⏰ Esecuzione backup settimanale programmato...');
    await runBackup();
  });

  console.log('✅ Scheduler avviato. Backup ogni domenica alle 2:00.');
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