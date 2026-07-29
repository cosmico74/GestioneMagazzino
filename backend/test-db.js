require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  try {
    console.log('🔍 Test connessione al database...');
    console.log('Host:', process.env.DB_HOST);
    console.log('User:', process.env.DB_USER);
    console.log('Database:', process.env.DB_NAME);
    console.log('Port:', process.env.DB_PORT);
    
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: parseInt(process.env.DB_PORT),
      ssl: { rejectUnauthorized: false } // Importante per Aiven
    });
    
    const [rows] = await pool.query('SELECT 1 as test');
    console.log('✅ Connessione riuscita!', rows);
    await pool.end();
  } catch (err) {
    console.error('❌ Errore di connessione:', err.message);
    console.error('Dettagli:', err);
  }
}

testConnection();