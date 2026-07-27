const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');

router.get('/', verifyToken, async (req, res) => {
  // Verifica che l'utente sia l'amministratore principale (username = 'admin')
  try {
    const [userRows] = await pool.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
    if (userRows.length === 0 || userRows[0].username !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accesso negato: solo l\'utente admin può fare il backup.' });
    }
  } catch (err) {
    console.error('Errore verifica utente:', err);
    return res.status(500).json({ success: false, message: 'Errore interno' });
  }

  try {
    // Ottieni tutte le tabelle del database
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(row => Object.values(row)[0]);

    let sql = '-- Backup del database\n';
    sql += `-- Generato il ${new Date().toISOString()}\n`;
    sql += '-- Utente: ' + req.userId + '\n\n';
    sql += 'SET FOREIGN_KEY_CHECKS = 0;\n\n';

    for (const table of tableNames) {
      // CREATE TABLE
      const [createResult] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
      const createSQL = createResult[0]['Create Table'];
      sql += `DROP TABLE IF EXISTS \`${table}\`;\n${createSQL};\n\n`;

      // SELECT dati
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

    // Invia il file come download
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename=backup_${new Date().toISOString().slice(0,10)}.sql`);
    res.send(sql);
  } catch (err) {
    console.error('❌ Errore durante il backup:', err);
    res.status(500).json({ success: false, message: 'Errore durante la generazione del backup: ' + err.message });
  }
});

module.exports = router;