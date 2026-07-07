const mysql = require('mysql2/promise');
const fs = require('fs');
require('dotenv').config();

// Verifica se il file ca.pem esiste
let sslConfig = {};
try {
  if (fs.existsSync('./ca.pem')) {
    sslConfig = { ca: fs.readFileSync('./ca.pem') };
    console.log('SSL configurato con ca.pem');
  } else {
    console.warn('File ca.pem non trovato, connessione senza SSL (se il database lo consente)');
  }
} catch (e) {
  console.warn('Errore nel caricamento di ca.pem:', e.message);
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: Object.keys(sslConfig).length ? sslConfig : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

function now() { return new Date(); }

module.exports = pool;
module.exports.now = now;