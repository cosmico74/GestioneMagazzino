const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');
const bcrypt = require('bcrypt');

const router = express.Router();

// Helper: controlla se l'utente è admin
async function isAdmin(userId) {
  const [rows] = await pool.query('SELECT ruolo FROM utenti WHERE id = ?', [userId]);
  return rows.length && rows[0].ruolo === 'admin';
}

// GET /api/utenti
router.get('/', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    const [rows] = await pool.query(`
      SELECT u.id, u.username, u.ruolo, u.riferimento_id, u.nome_visualizzato, u.email,
             s.tipo AS soggetto_tipo, s.nome AS soggetto_nome, s.cognome AS soggetto_cognome
      FROM utenti u
      LEFT JOIN soggetti s ON u.riferimento_id = s.id
      ORDER BY u.id
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/utenti
router.post('/', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    const { username, password, ruolo, riferimentoId, nomeVisualizzato, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username e password obbligatori' });
    }
    const [existing] = await pool.query('SELECT id FROM utenti WHERE username = ?', [username]);
    if (existing.length) {
      return res.status(400).json({ success: false, message: 'Username già esistente' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO utenti (username, password_hash, ruolo, riferimento_id, nome_visualizzato, email)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username, hashed, ruolo, riferimentoId || null, nomeVisualizzato || null, email || null]
    );
    res.json({ success: true, message: 'Utente creato', id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/utenti/:id
router.put('/:id', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    const { id } = req.params;
    const { username, password, ruolo, riferimentoId, nomeVisualizzato, email } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username obbligatorio' });
    }
    // Verifica che username non sia già usato da un altro utente
    const [existing] = await pool.query('SELECT id FROM utenti WHERE username = ? AND id != ?', [username, id]);
    if (existing.length) {
      return res.status(400).json({ success: false, message: 'Username già in uso da un altro utente' });
    }
    let sql = 'UPDATE utenti SET username = ?, ruolo = ?, riferimento_id = ?, nome_visualizzato = ?, email = ?';
    const params = [username, ruolo, riferimentoId || null, nomeVisualizzato || null, email || null];
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      sql += ', password_hash = ?';
      params.push(hashed);
    }
    sql += ' WHERE id = ?';
    params.push(id);
    await pool.query(sql, params);
    res.json({ success: true, message: 'Utente aggiornato' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/utenti/:id
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    // Non permettere di eliminare se stessi
    if (parseInt(req.params.id) === req.userId) {
      return res.status(400).json({ success: false, message: 'Non puoi eliminare il tuo stesso utente' });
    }
    await pool.query('DELETE FROM utenti WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Utente eliminato' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;