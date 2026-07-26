const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');

router.get('/', verifyToken, async (req, res) => {
  // Solo l'utente specifico "admin" può fare il backup
  // Verifichiamo sia il ruolo che lo username
  if (req.userRole !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accesso negato: solo admin' });
  }

  // Ottieni l'username dell'utente
  const [rows] = await pool.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
  if (rows.length === 0 || rows[0].username !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accesso negato: solo utente admin' });
  }

  try {
    // ... resto del codice invariato ...
  } catch (err) {
    console.error('❌ Errore backup:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;