const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../auth');

const router = express.Router();

// ============================================================
// GET /api/anagrafiche/magazzini – filtrati per soggetto
// ============================================================
router.get('/magazzini', verifyToken, async (req, res) => {
  try {
    let sql = 'SELECT magazzino_id AS id, nome FROM magazzini WHERE attivo = true';
    let params = [];

    // Se l'utente non è admin, filtra per i magazzini associati al suo soggetto
    if (req.userRole !== 'admin') {
      const [user] = await pool.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
      if (user.length && user[0].riferimento_id) {
        const soggettoId = user[0].riferimento_id;
        sql = `
          SELECT m.magazzino_id AS id, m.nome 
          FROM magazzini m
          INNER JOIN soggetti_magazzini sm ON m.magazzino_id = sm.magazzino_id
          WHERE sm.soggetto_id = ? AND m.attivo = true
          ORDER BY m.nome
        `;
        params.push(soggettoId);
      } else {
        return res.json([]);
      }
    } else {
      sql += ' ORDER BY nome';
    }

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /magazzini:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ALTRE ROUTE (invariate)
// ============================================================
router.get('/settori', verifyToken, async (req, res) => {
  const [rows] = await pool.query('SELECT settore_id AS id, nome, descrizione, attivo FROM settori WHERE attivo = true ORDER BY nome');
  res.json(rows);
});

router.get('/categorie', verifyToken, async (req, res) => {
  const [rows] = await pool.query('SELECT categoria_id AS id, nome, descrizione, attivo FROM categorie WHERE attivo = true ORDER BY nome');
  res.json(rows);
});

router.get('/marche', verifyToken, async (req, res) => {
  const [rows] = await pool.query('SELECT marca_id AS id, nome, descrizione, sito_web, attivo FROM marche WHERE attivo = true ORDER BY nome');
  res.json(rows);
});

// ============================================================
// GET /api/anagrafiche/menu
// ============================================================
router.get('/menu', verifyToken, async (req, res) => {
  try {
    const [userRows] = await pool.query('SELECT * FROM utenti WHERE id = ?', [req.userId]);
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Utente non trovato' });
    }
    const user = userRows[0];
    const ruolo = user.ruolo;
    let livello = null;
    if (user.riferimento_id) {
      const [sog] = await pool.query('SELECT livello FROM soggetti WHERE id = ?', [user.riferimento_id]);
      if (sog.length) {
        livello = parseInt(sog[0].livello, 10);
      }
    } else if (ruolo === 'promoter') {
      livello = 1;
    }

    const [menuRows] = await pool.query(`
      SELECT settore_id AS id, titolo, descrizione, icona, url, ordine, ruoli, livelli
      FROM menu_items
      ORDER BY ordine
    `);

    const allowed = menuRows.filter(item => {
      if (!item.ruoli) return false;
      const ruoliAmmessi = item.ruoli.split(',').map(r => r.trim());
      if (!ruoliAmmessi.includes(ruolo)) return false;
      if (ruolo === 'promoter' && item.livelli && item.livelli.trim() !== '') {
        const livelliAmmessi = item.livelli.split(',').map(l => parseInt(l.trim(), 10));
        if (livello === null || !livelliAmmessi.includes(livello)) {
          return false;
        }
      }
      return true;
    });

    const menuData = allowed.map(item => ({
      id: item.id,
      titolo: item.titolo,
      descrizione: item.descrizione,
      icona: item.icona,
      url: item.url,
      ordine: item.ordine
    }));
    res.json(menuData);
  } catch (error) {
    console.error('Errore in /menu:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// CRUD MARCHE (invariato)
// ============================================================
router.get('/marche/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT marca_id AS id, nome, descrizione, sito_web, attivo FROM marche ORDER BY nome');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/marche', verifyToken, async (req, res) => {
  try {
    const { nome, descrizione, sito_web, attivo } = req.body;
    if (!nome) return res.status(400).json({ success: false, message: 'Il nome è obbligatorio' });
    const [result] = await pool.query(
      'INSERT INTO marche (nome, descrizione, sito_web, attivo) VALUES (?, ?, ?, ?)',
      [nome, descrizione || null, sito_web || null, attivo !== undefined ? attivo : 1]
    );
    res.json({ success: true, message: 'Marca creata', id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/marche/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descrizione, sito_web, attivo } = req.body;
    if (!nome) return res.status(400).json({ success: false, message: 'Il nome è obbligatorio' });
    await pool.query(
      'UPDATE marche SET nome = ?, descrizione = ?, sito_web = ?, attivo = ? WHERE marca_id = ?',
      [nome, descrizione || null, sito_web || null, attivo !== undefined ? attivo : 1, id]
    );
    res.json({ success: true, message: 'Marca aggiornata' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/marche/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM marche WHERE marca_id = ?', [id]);
    res.json({ success: true, message: 'Marca eliminata' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CRUD CATEGORIE (invariato)
// ============================================================
router.get('/categorie/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT categoria_id AS id, nome, descrizione, attivo FROM categorie ORDER BY nome');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/categorie', verifyToken, async (req, res) => {
  try {
    const { nome, descrizione, attivo } = req.body;
    if (!nome) return res.status(400).json({ success: false, message: 'Il nome è obbligatorio' });
    const [result] = await pool.query(
      'INSERT INTO categorie (nome, descrizione, attivo) VALUES (?, ?, ?)',
      [nome, descrizione || null, attivo !== undefined ? attivo : 1]
    );
    res.json({ success: true, message: 'Categoria creata', id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/categorie/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descrizione, attivo } = req.body;
    if (!nome) return res.status(400).json({ success: false, message: 'Il nome è obbligatorio' });
    await pool.query(
      'UPDATE categorie SET nome = ?, descrizione = ?, attivo = ? WHERE categoria_id = ?',
      [nome, descrizione || null, attivo !== undefined ? attivo : 1, id]
    );
    res.json({ success: true, message: 'Categoria aggiornata' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/categorie/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM categorie WHERE categoria_id = ?', [id]);
    res.json({ success: true, message: 'Categoria eliminata' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CRUD SETTORI (invariato)
// ============================================================
router.get('/settori/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT settore_id AS id, nome, descrizione, attivo FROM settori ORDER BY nome');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settori', verifyToken, async (req, res) => {
  try {
    const { nome, descrizione, attivo } = req.body;
    if (!nome) return res.status(400).json({ success: false, message: 'Il nome è obbligatorio' });
    const [result] = await pool.query(
      'INSERT INTO settori (nome, descrizione, attivo) VALUES (?, ?, ?)',
      [nome, descrizione || null, attivo !== undefined ? attivo : 1]
    );
    res.json({ success: true, message: 'Settore creato', id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/settori/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descrizione, attivo } = req.body;
    if (!nome) return res.status(400).json({ success: false, message: 'Il nome è obbligatorio' });
    await pool.query(
      'UPDATE settori SET nome = ?, descrizione = ?, attivo = ? WHERE settore_id = ?',
      [nome, descrizione || null, attivo !== undefined ? attivo : 1, id]
    );
    res.json({ success: true, message: 'Settore aggiornato' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/settori/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM settori WHERE settore_id = ?', [id]);
    res.json({ success: true, message: 'Settore eliminato' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;