const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const fs = require('fs');
require('dotenv').config();

(async () => {
    try {
        console.log('🔍 Connessione al database...');
        
        const pool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: process.env.DB_PORT || 3306,
            ssl: { ca: fs.readFileSync('./ca.pem') }
        });

        console.log('✅ Connessione riuscita!');
        
        // Cerca l'utente admin
        const [rows] = await pool.query('SELECT id, username, password_hash, ruolo FROM utenti WHERE username = ?', ['admin']);
        
        if (rows.length === 0) {
            console.log('❌ Utente admin non trovato!');
            console.log('   Esegui: INSERT INTO utenti (username, password_hash, ruolo, nome_visualizzato) VALUES ("admin", "HASH_GENERATO", "admin", "Amministratore");');
            process.exit(1);
        }
        
        const user = rows[0];
        console.log('👤 Utente trovato:', user.username);
        console.log('🔑 Hash salvato:', user.password_hash);
        
        // Testa la password "admin"
        const match = await bcrypt.compare('admin', user.password_hash);
        console.log('🔐 Password "admin" corrisponde?', match ? '✅ SI' : '❌ NO');
        
        if (!match) {
            console.log('⚠️ Genera un nuovo hash con:');
            console.log('   node -e "const bcrypt = require(\'bcrypt\'); bcrypt.hash(\'admin\', 10).then(h => console.log(h));"');
            console.log('Poi aggiorna il database con:');
            console.log('   UPDATE utenti SET password_hash = "NUOVO_HASH" WHERE username = "admin";');
        }
        
        await pool.end();
    } catch (err) {
        console.error('❌ Errore:', err.message);
        if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('   Controlla username e password nel file .env');
        } else if (err.code === 'ENOENT') {
            console.log('   File ca.pem non trovato. Scaricalo da Aiven e mettilo in backend/');
        }
    }
})();