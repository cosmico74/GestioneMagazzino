const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');

console.log('✅ kit.js caricato (versione minimal)');

// ROTTA /articoli - versione SEMPLICE
router.get('/articoli', verifyToken, async (req, res) => {
  console.log('🔍 GET /api/kit/articoli chiamata!');
  try {
    const [rows] = await db.query(`
      SELECT 
        MIN(a.articolo_id) AS articolo_id,
        a.descrizione,
        a.lunghezza,
        a.magazzino,
        a.settore,
        a.categoria,
        a.marca,
        a.codice_modello,
        SUM(a.quantita_totale) AS quantita_totale,
        GROUP_CONCAT(a.articolo_id) AS articoli_ids
      FROM articoli a
      WHERE a.quantita_totale > 0 AND a.stato = 'Disponibile'
      GROUP BY a.descrizione, a.lunghezza, a.magazzino, a.settore, a.categoria, a.marca, a.codice_modello
      ORDER BY a.descrizione
    `);
    const result = rows.map(row => ({
      ...row,
      articoli_ids: row.articoli_ids ? row.articoli_ids.split(',').map(Number) : []
    }));
    res.json(result);
  } catch (err) {
    console.error('Errore GET /kit/articoli:', err);
    res.status(500).json({ error: err.message });
  }
});

// ROTTA /sigle-usate - versione SEMPLICE
router.get('/sigle-usate', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT kd.sigla_id AS id, s.sigla
      FROM kit_dettaglio kd
      INNER JOIN sigle_articoli s ON kd.sigla_id = s.id
      WHERE s.attivo = 1
      ORDER BY s.sigla
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROTTA /articoli/sigle - versione SEMPLICE
router.get('/articoli/sigle', verifyToken, async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.json([]);
  const idArray = ids.split(',').map(Number).filter(id => !isNaN(id));
  if (!idArray.length) return res.json([]);
  const placeholders = idArray.map(() => '?').join(',');
  try {
    const [rows] = await db.query(`
      SELECT 
        s.id,
        s.sigla,
        s.quantita,
        (COALESCE(s.quantita, 0) - COALESCE((SELECT SUM(quantita) FROM kit_dettaglio WHERE sigla_id = s.id), 0) - 
         COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE sigla_id = s.id AND tipo_oggetto = 'ARTICOLO'), 0)) AS giacenza
      FROM sigle_articoli s
      WHERE s.articolo_id IN (${placeholders}) AND s.attivo = 1
      ORDER BY s.sigla
    `, idArray);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROTTA GET /kit - versione SEMPLICE
router.get('/', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM kit ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;