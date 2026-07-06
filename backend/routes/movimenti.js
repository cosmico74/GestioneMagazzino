const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');

// ============================================================
// REPORT AUSTRIA – solo articoli (quantità totale)
// ============================================================
router.get('/austria', verifyToken, async (req, res) => {
  try {
    const { magazzino } = req.query;
    let sql = `
      SELECT a.articolo_id, a.codice, a.descrizione, a.codice_modello,
             a.lunghezza, a.durezza, a.note AS nota, a.quantita_totale,
             m.nome AS magazzino_nome
      FROM articoli a
      LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
      WHERE a.quantita_totale > 0
    `;
    const params = [];
    if (magazzino) {
      sql += ' AND a.magazzino = ?';
      params.push(magazzino);
    }
    sql += ' ORDER BY a.codice';
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Errore report austria:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// REPORT ITALIA – articoli + kit (in magazzino e assegnati)
// con quantità totale e giacenza reale
// ============================================================
router.get('/italia', verifyToken, async (req, res) => {
  try {
    const { magazzino, tipo } = req.query;
    const includeArticoli = tipo === 'ARTICOLO' || tipo === 'ENTRAMBI' || !tipo;
    const includeKit = tipo === 'KIT' || tipo === 'ENTRAMBI' || !tipo;

    let risultati = [];

    // --- ARTICOLI ---
    if (includeArticoli) {
      // 1. Articoli in magazzino (giacenza > 0)
      let sqlMagazzino = `
        SELECT a.articolo_id, a.codice, a.descrizione, a.codice_modello,
               a.lunghezza, a.durezza, a.note AS nota,
               a.quantita_totale AS quantita_totale,
               (a.quantita_totale - a.quantita_in_kit - a.quantita_obsoleta - 
                COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) AS giacenza,
               m.nome AS magazzino_nome,
               'In magazzino' AS stato,
               NULL AS destinatario
        FROM articoli a
        LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
        WHERE (a.quantita_totale - a.quantita_in_kit - a.quantita_obsoleta - 
               COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) > 0
      `;
      const paramsMag = [];
      if (magazzino) {
        sqlMagazzino += ' AND a.magazzino = ?';
        paramsMag.push(magazzino);
      }
      sqlMagazzino += ' ORDER BY a.codice';
      const [rowsMag] = await pool.query(sqlMagazzino, paramsMag);
      risultati = risultati.concat(rowsMag.map(r => ({ ...r, tipo_oggetto: 'ARTICOLO' })));

      // 2. Articoli assegnati (in carico_sintesi)
      let sqlAssegnati = `
        SELECT a.articolo_id, a.codice, a.descrizione, a.codice_modello,
               a.lunghezza, a.durezza, a.note AS nota,
               a.quantita_totale AS quantita_totale,
               0 AS giacenza,
               m.nome AS magazzino_nome,
               'Assegnato' AS stato,
               CONCAT(COALESCE(sog.nome, ''), ' ', COALESCE(sog.cognome, '')) AS destinatario
        FROM carico_sintesi cs
        INNER JOIN articoli a ON cs.oggetto_id = a.articolo_id AND cs.tipo_oggetto = 'ARTICOLO'
        LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
        LEFT JOIN soggetti sog ON sog.id = cs.destinazione_id AND sog.tipo = cs.destinazione_tipo
        WHERE cs.tipo_oggetto = 'ARTICOLO' AND cs.quantita > 0
      `;
      const paramsAssegnati = [];
      sqlAssegnati += ' ORDER BY a.codice';
      const [rowsAssegnati] = await pool.query(sqlAssegnati, paramsAssegnati);
      risultati = risultati.concat(rowsAssegnati.map(r => ({ ...r, tipo_oggetto: 'ARTICOLO' })));
    }

    // --- KIT ---
    if (includeKit) {
      // 1. Kit in magazzino (giacenza > 0)
      let sqlKitMagazzino = `
        SELECT k.id AS articolo_id, k.codice_kit AS codice, k.descrizione,
               k.note AS nota,
               k.quantita AS quantita_totale,
               (k.quantita - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'KIT' AND oggetto_id = k.id), 0)) AS giacenza,
               m.nome AS magazzino_nome,
               'In magazzino' AS stato,
               NULL AS destinatario,
               (SELECT a.lunghezza FROM kit_dettaglio kd 
                LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id 
                WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS lunghezza,
               (SELECT s.sigla FROM kit_dettaglio kd 
                LEFT JOIN sigle_articoli s ON kd.sigla_id = s.id 
                WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS sigla_sci
        FROM kit k
        LEFT JOIN magazzini m ON k.magazzino = m.magazzino_id
        WHERE (k.quantita - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'KIT' AND oggetto_id = k.id), 0)) > 0
      `;
      const paramsKitMag = [];
      if (magazzino) {
        sqlKitMagazzino += ' AND k.magazzino = ?';
        paramsKitMag.push(magazzino);
      }
      sqlKitMagazzino += ' ORDER BY k.codice_kit';
      const [rowsKitMag] = await pool.query(sqlKitMagazzino, paramsKitMag);
      risultati = risultati.concat(rowsKitMag.map(r => ({ ...r, tipo_oggetto: 'KIT' })));

      // 2. Kit assegnati (in carico_sintesi)
      let sqlKitAssegnati = `
        SELECT k.id AS articolo_id, k.codice_kit AS codice, k.descrizione,
               k.note AS nota,
               k.quantita AS quantita_totale,
               0 AS giacenza,
               m.nome AS magazzino_nome,
               'Assegnato' AS stato,
               CONCAT(COALESCE(sog.nome, ''), ' ', COALESCE(sog.cognome, '')) AS destinatario,
               (SELECT a.lunghezza FROM kit_dettaglio kd 
                LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id 
                WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS lunghezza,
               (SELECT s.sigla FROM kit_dettaglio kd 
                LEFT JOIN sigle_articoli s ON kd.sigla_id = s.id 
                WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS sigla_sci
        FROM carico_sintesi cs
        INNER JOIN kit k ON cs.oggetto_id = k.id AND cs.tipo_oggetto = 'KIT'
        LEFT JOIN magazzini m ON k.magazzino = m.magazzino_id
        LEFT JOIN soggetti sog ON sog.id = cs.destinazione_id AND sog.tipo = cs.destinazione_tipo
        WHERE cs.tipo_oggetto = 'KIT' AND cs.quantita > 0
      `;
      const paramsKitAss = [];
      sqlKitAssegnati += ' ORDER BY k.codice_kit';
      const [rowsKitAss] = await pool.query(sqlKitAssegnati, paramsKitAss);
      risultati = risultati.concat(rowsKitAss.map(r => ({ ...r, tipo_oggetto: 'KIT' })));
    }

    res.json({ success: true, data: risultati });
  } catch (err) {
    console.error('Errore report italia:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// REPORT SOGGETTI – oggetti in carico/inviati
// ============================================================
router.get('/soggetti', verifyToken, async (req, res) => {
  try {
    const { soggetto_id, modalita } = req.query;
    if (!soggetto_id) {
      return res.status(400).json({ success: false, message: 'soggetto_id richiesto' });
    }

    const [soggetto] = await pool.query('SELECT tipo FROM soggetti WHERE id = ?', [soggetto_id]);
    if (!soggetto.length) {
      return res.status(404).json({ success: false, message: 'Soggetto non trovato' });
    }
    const tipo = soggetto[0].tipo;

    let risultati = [];
    const modalitaVal = modalita || 'incarico';

    // In carico
    if (modalitaVal === 'incarico' || modalitaVal === 'entrambi') {
      const [rows] = await pool.query(`
        SELECT cs.*,
          CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione ELSE k.descrizione END AS descrizione,
          CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice ELSE k.codice_kit END AS codice,
          a.lunghezza,
          COALESCE(s.sigla, 
            (SELECT s2.sigla FROM kit_dettaglio kd 
             LEFT JOIN sigle_articoli s2 ON kd.sigla_id = s2.id 
             WHERE kd.kit_id = cs.oggetto_id AND kd.tipo_articolo = 'SCI' LIMIT 1)
          ) AS sigla_corrente,
          a.note AS nota_articolo,
          k.note AS nota_kit,
          sog.nome AS destinatario_nome,
          sog.cognome AS destinatario_cognome
        FROM carico_sintesi cs
        LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
        LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
        LEFT JOIN sigle_articoli s ON cs.sigla_id = s.id
        LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
        WHERE cs.destinazione_tipo = ? AND cs.destinazione_id = ? AND cs.quantita > 0
      `, [tipo, soggetto_id]);
      rows.forEach(row => {
        risultati.push({
          tipo: row.tipo_oggetto,
          codice_sigla: row.codice || '',
          descrizione: row.descrizione || '',
          lunghezza: row.lunghezza || '',
          sigla: row.sigla_corrente || 'NA',
          quantita: row.quantita,
          stato: 'In carico',
          destinatario: row.destinazione_tipo === 'PROMOTER'
            ? ((row.destinatario_nome || '') + ' ' + (row.destinatario_cognome || '')).trim()
            : (row.destinatario_nome || 'Magazzino'),
          data: row.data_assegnazione,
          nota: row.tipo_oggetto === 'ARTICOLO' ? row.nota_articolo : row.nota_kit
        });
      });
    }

    // Inviati
    if (modalitaVal === 'inviati' || modalitaVal === 'entrambi') {
      const [rows] = await pool.query(`
        SELECT cs.*,
          CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione ELSE k.descrizione END AS descrizione,
          CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice ELSE k.codice_kit END AS codice,
          a.lunghezza,
          COALESCE(s.sigla, 
            (SELECT s2.sigla FROM kit_dettaglio kd 
             LEFT JOIN sigle_articoli s2 ON kd.sigla_id = s2.id 
             WHERE kd.kit_id = cs.oggetto_id AND kd.tipo_articolo = 'SCI' LIMIT 1)
          ) AS sigla_corrente,
          a.note AS nota_articolo,
          k.note AS nota_kit,
          sog.nome AS destinatario_nome,
          sog.cognome AS destinatario_cognome
        FROM carico_sintesi cs
        LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
        LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
        LEFT JOIN sigle_articoli s ON cs.sigla_id = s.id
        LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
        WHERE cs.provenienza_tipo = ? AND cs.provenienza_id = ? AND cs.quantita > 0
      `, [tipo, soggetto_id]);
      rows.forEach(row => {
        risultati.push({
          tipo: row.tipo_oggetto,
          codice_sigla: row.codice || '',
          descrizione: row.descrizione || '',
          lunghezza: row.lunghezza || '',
          sigla: row.sigla_corrente || 'NA',
          quantita: row.quantita,
          stato: 'Assegnato',
          destinatario: row.destinazione_tipo === 'PROMOTER'
            ? ((row.destinatario_nome || '') + ' ' + (row.destinatario_cognome || '')).trim()
            : (row.destinatario_nome || 'Magazzino'),
          data: row.data_assegnazione,
          nota: row.tipo_oggetto === 'ARTICOLO' ? row.nota_articolo : row.nota_kit
        });
      });
    }

    res.json({ success: true, data: risultati });
  } catch (err) {
    console.error('Errore report soggetti:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;