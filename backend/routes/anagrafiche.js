const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../auth');

const router = express.Router();

// ============================================================
// GET /api/anagrafiche/magazzini
// ============================================================
router.get('/magazzini', verifyToken, async (req, res) => {
  try {
    let sql = 'SELECT magazzino_id AS id, nome FROM magazzini WHERE attivo = true';
    let params = [];

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
// GET /api/anagrafiche/settori
// ============================================================
router.get('/settori', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT settore_id AS id, nome, descrizione, attivo FROM settori WHERE attivo = true ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /settori:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/anagrafiche/categorie
// ============================================================
router.get('/categorie', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT categoria_id AS id, nome, descrizione, attivo FROM categorie WHERE attivo = true ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /categorie:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/anagrafiche/marche
// ============================================================
router.get('/marche', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT marca_id AS id, nome, descrizione, sito_web, attivo FROM marche WHERE attivo = true ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /marche:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔥 GET /api/anagrafiche/season-status - NUOVA ROTTA
// ============================================================
router.get('/season-status', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nome, descrizione FROM season_status WHERE attivo = true ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ Errore GET /season-status:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/anagrafiche/anni
// ============================================================
router.get('/anni', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, anno, descrizione FROM anni WHERE attivo = true ORDER BY anno DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /anni:', err);
    res.status(500).json({ error: err.message });
  }
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

    if (ruolo === 'admin') {
      const menuData = menuRows.map(item => ({
        id: item.id,
        titolo: item.titolo,
        descrizione: item.descrizione,
        icona: item.icona,
        url: item.url,
        ordine: item.ordine
      }));
      return res.json(menuData);
    }

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
// CRUD MARCHE
// ============================================================
router.get('/marche/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT marca_id AS id, nome, descrizione, sito_web, attivo FROM marche ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /marche/tutti:', err);
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
    console.error('Errore POST /marche:', err);
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
    console.error('Errore PUT /marche/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/marche/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM marche WHERE marca_id = ?', [id]);
    res.json({ success: true, message: 'Marca eliminata' });
  } catch (err) {
    console.error('Errore DELETE /marche/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CRUD CATEGORIE
// ============================================================
router.get('/categorie/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT categoria_id AS id, nome, descrizione, attivo FROM categorie ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /categorie/tutti:', err);
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
    console.error('Errore POST /categorie:', err);
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
    console.error('Errore PUT /categorie/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/categorie/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM categorie WHERE categoria_id = ?', [id]);
    res.json({ success: true, message: 'Categoria eliminata' });
  } catch (err) {
    console.error('Errore DELETE /categorie/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CRUD SETTORI
// ============================================================
router.get('/settori/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT settore_id AS id, nome, descrizione, attivo FROM settori ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /settori/tutti:', err);
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
    console.error('Errore POST /settori:', err);
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
    console.error('Errore PUT /settori/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/settori/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM settori WHERE settore_id = ?', [id]);
    res.json({ success: true, message: 'Settore eliminato' });
  } catch (err) {
    console.error('Errore DELETE /settori/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET /api/anagrafiche/marche-per-categoria/:categoriaId
// ============================================================
router.get('/marche-per-categoria/:categoriaId', verifyToken, async (req, res) => {
  try {
    const { categoriaId } = req.params;
    const { settore } = req.query;
    let sql = `
      SELECT m.marca_id AS id, m.nome
      FROM marche m
      INNER JOIN categorie_marche cm ON m.marca_id = cm.marca_id
      WHERE cm.categoria_id = ?
    `;
    const params = [categoriaId];
    if (settore) {
      sql += ` AND m.marca_id IN (SELECT DISTINCT marca FROM articoli WHERE settore = ?)`;
      params.push(settore);
    }
    sql += ' ORDER BY m.nome';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Errore marche per categoria:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SETTORI MARCHE - Gestione abbinamenti
// ============================================================
router.get('/settori-marche/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sm.*, s.nome AS settore_nome, m.nome AS marca_nome
      FROM settori_marche sm
      LEFT JOIN settori s ON sm.settore_id = s.settore_id
      LEFT JOIN marche m ON sm.marca_id = m.marca_id
      ORDER BY s.nome, m.nome
    `);
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /settori-marche/tutti:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/settori-marche/:settoreId', verifyToken, async (req, res) => {
  const { settoreId } = req.params;
  try {
    const [rows] = await pool.query(`
      SELECT m.marca_id AS id, m.nome
      FROM settori_marche sm
      LEFT JOIN marche m ON sm.marca_id = m.marca_id
      WHERE sm.settore_id = ? AND m.attivo = 1
      ORDER BY m.nome
    `, [settoreId]);
    res.json(rows);
  } catch (err) {
    console.error(`Errore GET /settori-marche/${settoreId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/settori-marche', verifyToken, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ success: false, message: 'Solo admin può modificare gli abbinamenti' });
  }
  const { settore_id, marca_id } = req.body;
  if (!settore_id || !marca_id) {
    return res.status(400).json({ success: false, message: 'settore_id e marca_id obbligatori' });
  }
  try {
    const [settore] = await pool.query('SELECT settore_id FROM settori WHERE settore_id = ?', [settore_id]);
    if (!settore.length) {
      return res.status(404).json({ success: false, message: 'Settore non trovato' });
    }
    const [marca] = await pool.query('SELECT marca_id FROM marche WHERE marca_id = ?', [marca_id]);
    if (!marca.length) {
      return res.status(404).json({ success: false, message: 'Marca non trovata' });
    }
    await pool.query(
      'INSERT INTO settori_marche (settore_id, marca_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE settore_id = VALUES(settore_id)',
      [settore_id, marca_id]
    );
    res.json({ success: true, message: 'Associazione creata' });
  } catch (err) {
    console.error('Errore POST /settori-marche:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/settori-marche', verifyToken, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ success: false, message: 'Solo admin può modificare gli abbinamenti' });
  }
  const { settore_id, marca_id } = req.body;
  if (!settore_id || !marca_id) {
    return res.status(400).json({ success: false, message: 'settore_id e marca_id obbligatori' });
  }
  try {
    await pool.query(
      'DELETE FROM settori_marche WHERE settore_id = ? AND marca_id = ?',
      [settore_id, marca_id]
    );
    res.json({ success: true, message: 'Associazione rimossa' });
  } catch (err) {
    console.error('Errore DELETE /settori-marche:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CATEGORIE MARCHE – Gestione abbinamenti
// ============================================================
router.get('/categorie-marche/tutti', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT cm.id, cm.categoria_id, cm.marca_id,
        c.nome AS categoria_nome, m.nome AS marca_nome
      FROM categorie_marche cm
      LEFT JOIN categorie c ON cm.categoria_id = c.categoria_id
      LEFT JOIN marche m ON cm.marca_id = m.marca_id
      ORDER BY c.nome, m.nome
    `);
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /categorie-marche/tutti:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/categorie-marche', verifyToken, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ success: false, message: 'Solo admin può modificare gli abbinamenti' });
  }
  const { categoria_id, marca_id } = req.body;
  if (!categoria_id || !marca_id) {
    return res.status(400).json({ success: false, message: 'categoria_id e marca_id obbligatori' });
  }
  try {
    const [cat] = await pool.query('SELECT categoria_id FROM categorie WHERE categoria_id = ?', [categoria_id]);
    if (!cat.length) return res.status(404).json({ success: false, message: 'Categoria non trovata' });
    const [mar] = await pool.query('SELECT marca_id FROM marche WHERE marca_id = ?', [marca_id]);
    if (!mar.length) return res.status(404).json({ success: false, message: 'Marca non trovata' });

    await pool.query(
      'INSERT INTO categorie_marche (categoria_id, marca_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE categoria_id = VALUES(categoria_id)',
      [categoria_id, marca_id]
    );
    res.json({ success: true, message: 'Associazione creata' });
  } catch (err) {
    console.error('Errore POST /categorie-marche:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/categorie-marche', verifyToken, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ success: false, message: 'Solo admin può modificare gli abbinamenti' });
  }
  const { categoria_id, marca_id } = req.body;
  if (!categoria_id || !marca_id) {
    return res.status(400).json({ success: false, message: 'categoria_id e marca_id obbligatori' });
  }
  try {
    await pool.query(
      'DELETE FROM categorie_marche WHERE categoria_id = ? AND marca_id = ?',
      [categoria_id, marca_id]
    );
    res.json({ success: true, message: 'Associazione rimossa' });
  } catch (err) {
    console.error('Errore DELETE /categorie-marche:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;