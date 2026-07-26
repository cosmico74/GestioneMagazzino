const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');

// ============================================================
// REPORT AUSTRIA – somma delle quantita_austria delle sigle
// ============================================================
router.get('/austria', verifyToken, async (req, res) => {
  try {
    const { magazzino } = req.query;
    let sql = `
      SELECT 
        a.articolo_id,
        a.codice,
        a.descrizione,
        a.codice_modello,
        a.lunghezza,
        a.durezza,
        a.note AS nota,
        COALESCE((SELECT SUM(s.quantita_austria) FROM sigle_articoli s WHERE s.articolo_id = a.articolo_id AND s.attivo = 1), 0) AS quantita_totale,
        m.nome AS magazzino_nome
      FROM articoli a
      LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
      WHERE COALESCE((SELECT SUM(s.quantita_austria) FROM sigle_articoli s WHERE s.articolo_id = a.articolo_id AND s.attivo = 1), 0) > 0
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
// REPORT ITALIA – articoli + kit (con raggruppamento e filtri)
// ============================================================
router.get('/italia', verifyToken, async (req, res) => {
  try {
    const { magazzino, tipo, raggruppa, filtro_codice, filtro_descrizione, filtro_lunghezza } = req.query;
    const includeArticoli = tipo === 'ARTICOLO' || tipo === 'ENTRAMBI' || !tipo;
    const includeKit = tipo === 'KIT' || tipo === 'ENTRAMBI' || !tipo;
    const raggruppaAttivo = raggruppa === 'true';

    let risultati = [];

    // --- ARTICOLI ---
    if (includeArticoli) {
      // 1. Articoli in magazzino (giacenza > 0)
      let sqlMagazzino = `
        SELECT 
          a.articolo_id,
          a.codice,
          a.descrizione,
          a.codice_modello,
          a.lunghezza,
          a.durezza,
          a.note AS nota,
          a.quantita_totale AS quantita,
          (a.quantita_totale - a.quantita_in_kit - a.quantita_obsoleta - 
           COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) AS giacenza,
          m.nome AS magazzino_nome,
          'In magazzino' AS stato,
          NULL AS destinatario,
          '' AS sigle
        FROM articoli a
        LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
        WHERE a.quantita_totale > 0
      `;
      const paramsMag = [];
      if (magazzino) {
        sqlMagazzino += ' AND a.magazzino = ?';
        paramsMag.push(magazzino);
      }
      if (filtro_codice) {
        sqlMagazzino += ' AND a.codice_modello LIKE ?';
        paramsMag.push(`%${filtro_codice}%`);
      }
      if (filtro_descrizione) {
        sqlMagazzino += ' AND a.descrizione LIKE ?';
        paramsMag.push(`%${filtro_descrizione}%`);
      }
      if (filtro_lunghezza) {
        sqlMagazzino += ' AND a.lunghezza LIKE ?';
        paramsMag.push(`%${filtro_lunghezza}%`);
      }
      sqlMagazzino += ' ORDER BY a.codice';
      let [rowsMag] = await pool.query(sqlMagazzino, paramsMag);

      // Filtra per giacenza > 0 (usando HAVING per sicurezza)
      rowsMag = rowsMag.filter(row => row.giacenza > 0);

      if (raggruppaAttivo) {
        const grouped = {};
        rowsMag.forEach(row => {
          const key = `${row.codice_modello}|${row.descrizione}|${row.lunghezza}|${row.magazzino_nome}`;
          if (!grouped[key]) {
            grouped[key] = {
              codice: row.codice_modello || row.codice || '',
              descrizione: row.descrizione || '',
              lunghezza: row.lunghezza || '',
              nota: row.nota || '',
              quantita: 0,
              giacenza: 0,
              magazzino_nome: row.magazzino_nome || '',
              stato: 'In magazzino',
              destinatario: null,
              sigle: [],
              tipo_oggetto: 'ARTICOLO',
              articolo_id: row.articolo_id,
              durezza: row.durezza || ''
            };
          }
          grouped[key].quantita += row.quantita || 0;
          grouped[key].giacenza += row.giacenza || 0;
        });
        for (const key of Object.keys(grouped)) {
          const group = grouped[key];
          const [sigleRows] = await pool.query(
            `SELECT s.sigla FROM sigle_articoli s
             INNER JOIN articoli a ON s.articolo_id = a.articolo_id
             WHERE a.codice_modello = ? AND a.descrizione = ? AND a.lunghezza = ? AND a.magazzino = (SELECT magazzino_id FROM magazzini WHERE nome = ?)
             AND s.attivo = 1 AND s.quantita > 0`,
            [group.codice, group.descrizione, group.lunghezza, group.magazzino_nome]
          );
          group.sigle = sigleRows.map(r => r.sigla).filter(Boolean).join(', ');
        }
        rowsMag = Object.values(grouped);
      } else {
        rowsMag = rowsMag.map(row => ({ ...row, sigle: '' }));
      }

      risultati = risultati.concat(rowsMag.map(r => ({ ...r, tipo_oggetto: 'ARTICOLO' })));

      // 2. Articoli assegnati
      let sqlAssegnati = `
        SELECT 
          a.articolo_id,
          a.codice,
          a.descrizione,
          a.codice_modello,
          a.lunghezza,
          a.durezza,
          a.note AS nota,
          cs.quantita AS quantita,
          0 AS giacenza,
          m.nome AS magazzino_nome,
          'Assegnato' AS stato,
          CONCAT(COALESCE(sog.nome, ''), ' ', COALESCE(sog.cognome, '')) AS destinatario,
          '' AS sigle
        FROM carico_sintesi cs
        INNER JOIN articoli a ON cs.oggetto_id = a.articolo_id AND cs.tipo_oggetto = 'ARTICOLO'
        LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
        LEFT JOIN soggetti sog ON sog.id = cs.destinazione_id AND sog.tipo = cs.destinazione_tipo
        WHERE cs.tipo_oggetto = 'ARTICOLO' AND cs.quantita > 0
      `;
      const paramsAssegnati = [];
      if (magazzino) {
        sqlAssegnati += ' AND a.magazzino = ?';
        paramsAssegnati.push(magazzino);
      }
      if (filtro_codice) {
        sqlAssegnati += ' AND a.codice_modello LIKE ?';
        paramsAssegnati.push(`%${filtro_codice}%`);
      }
      if (filtro_descrizione) {
        sqlAssegnati += ' AND a.descrizione LIKE ?';
        paramsAssegnati.push(`%${filtro_descrizione}%`);
      }
      if (filtro_lunghezza) {
        sqlAssegnati += ' AND a.lunghezza LIKE ?';
        paramsAssegnati.push(`%${filtro_lunghezza}%`);
      }
      sqlAssegnati += ' ORDER BY a.codice';
      let [rowsAssegnati] = await pool.query(sqlAssegnati, paramsAssegnati);

      if (raggruppaAttivo) {
        const grouped = {};
        rowsAssegnati.forEach(row => {
          const key = `${row.codice_modello}|${row.descrizione}|${row.lunghezza}|${row.magazzino_nome}|${row.destinatario}`;
          if (!grouped[key]) {
            grouped[key] = {
              codice: row.codice_modello || row.codice || '',
              descrizione: row.descrizione || '',
              lunghezza: row.lunghezza || '',
              nota: row.nota || '',
              quantita: 0,
              giacenza: 0,
              magazzino_nome: row.magazzino_nome || '',
              stato: 'Assegnato',
              destinatario: row.destinatario || '',
              sigle: [],
              tipo_oggetto: 'ARTICOLO',
              articolo_id: row.articolo_id,
              durezza: row.durezza || ''
            };
          }
          grouped[key].quantita += row.quantita || 0;
        });
        for (const key of Object.keys(grouped)) {
          const group = grouped[key];
          const [sigleRows] = await pool.query(
            `SELECT s.sigla FROM sigle_articoli s
             INNER JOIN articoli a ON s.articolo_id = a.articolo_id
             WHERE a.codice_modello = ? AND a.descrizione = ? AND a.lunghezza = ? AND a.magazzino = (SELECT magazzino_id FROM magazzini WHERE nome = ?)
             AND s.attivo = 1 AND s.quantita > 0`,
            [group.codice, group.descrizione, group.lunghezza, group.magazzino_nome]
          );
          group.sigle = sigleRows.map(r => r.sigla).filter(Boolean).join(', ');
        }
        rowsAssegnati = Object.values(grouped);
      } else {
        rowsAssegnati = rowsAssegnati.map(row => ({ ...row, sigle: '' }));
      }

      risultati = risultati.concat(rowsAssegnati.map(r => ({ ...r, tipo_oggetto: 'ARTICOLO' })));
    }

    // --- KIT ---
    if (includeKit) {
      // 1. Kit in magazzino (giacenza > 0) - CORRETTO CON HAVING
      let sqlKitMagazzino = `
        SELECT 
          k.id AS articolo_id,
          k.codice_kit AS codice,
          k.descrizione,
          k.note AS nota,
          k.quantita AS quantita,
          (k.quantita - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'KIT' AND oggetto_id = k.id), 0)) AS giacenza,
          m.nome AS magazzino_nome,
          'In magazzino' AS stato,
          NULL AS destinatario,
          (SELECT a.lunghezza FROM kit_dettaglio kd 
           LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id 
           WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS lunghezza,
          (SELECT s.sigla FROM kit_dettaglio kd 
           LEFT JOIN sigle_articoli s ON kd.sigla_id = s.id 
           WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS sigla_sci,
          '' AS sigle
        FROM kit k
        LEFT JOIN magazzini m ON k.magazzino = m.magazzino_id
        WHERE k.quantita > 0
      `;
      const paramsKitMag = [];
      if (magazzino) {
        sqlKitMagazzino += ' AND k.magazzino = ?';
        paramsKitMag.push(magazzino);
      }
      if (filtro_codice) {
        sqlKitMagazzino += ' AND k.codice_kit LIKE ?';
        paramsKitMag.push(`%${filtro_codice}%`);
      }
      if (filtro_descrizione) {
        sqlKitMagazzino += ' AND k.descrizione LIKE ?';
        paramsKitMag.push(`%${filtro_descrizione}%`);
      }
      if (filtro_lunghezza) {
        sqlKitMagazzino += ' AND EXISTS (SELECT 1 FROM kit_dettaglio kd LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id WHERE kd.kit_id = k.id AND kd.tipo_articolo = "SCI" AND a.lunghezza LIKE ?)';
        paramsKitMag.push(`%${filtro_lunghezza}%`);
      }
      sqlKitMagazzino += ' ORDER BY k.codice_kit';
      let [rowsKitMag] = await pool.query(sqlKitMagazzino, paramsKitMag);

      // 🔥 Filtra per giacenza > 0 (usando filter JavaScript perché HAVING non è supportato con subquery)
      rowsKitMag = rowsKitMag.filter(row => row.giacenza > 0);

      risultati = risultati.concat(rowsKitMag.map(r => ({ ...r, tipo_oggetto: 'KIT' })));

      // 2. Kit assegnati (solo quelli con giacenza = 0 o parziale)
      let sqlKitAssegnati = `
        SELECT 
          k.id AS articolo_id,
          k.codice_kit AS codice,
          k.descrizione,
          k.note AS nota,
          cs.quantita AS quantita,
          0 AS giacenza,
          m.nome AS magazzino_nome,
          'Assegnato' AS stato,
          CONCAT(COALESCE(sog.nome, ''), ' ', COALESCE(sog.cognome, '')) AS destinatario,
          (SELECT a.lunghezza FROM kit_dettaglio kd 
           LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id 
           WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS lunghezza,
          (SELECT s.sigla FROM kit_dettaglio kd 
           LEFT JOIN sigle_articoli s ON kd.sigla_id = s.id 
           WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI' LIMIT 1) AS sigla_sci,
          '' AS sigle
        FROM carico_sintesi cs
        INNER JOIN kit k ON cs.oggetto_id = k.id AND cs.tipo_oggetto = 'KIT'
        LEFT JOIN magazzini m ON k.magazzino = m.magazzino_id
        LEFT JOIN soggetti sog ON sog.id = cs.destinazione_id AND sog.tipo = cs.destinazione_tipo
        WHERE cs.tipo_oggetto = 'KIT' AND cs.quantita > 0
      `;
      const paramsKitAss = [];
      if (magazzino) {
        sqlKitAssegnati += ' AND k.magazzino = ?';
        paramsKitAss.push(magazzino);
      }
      if (filtro_codice) {
        sqlKitAssegnati += ' AND k.codice_kit LIKE ?';
        paramsKitAss.push(`%${filtro_codice}%`);
      }
      if (filtro_descrizione) {
        sqlKitAssegnati += ' AND k.descrizione LIKE ?';
        paramsKitAss.push(`%${filtro_descrizione}%`);
      }
      if (filtro_lunghezza) {
        sqlKitAssegnati += ' AND EXISTS (SELECT 1 FROM kit_dettaglio kd LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id WHERE kd.kit_id = k.id AND kd.tipo_articolo = "SCI" AND a.lunghezza LIKE ?)';
        paramsKitAss.push(`%${filtro_lunghezza}%`);
      }
      sqlKitAssegnati += ' ORDER BY k.codice_kit';
      const [rowsKitAss] = await pool.query(sqlKitAssegnati, paramsKitAss);
      risultati = risultati.concat(rowsKitAss.map(r => ({ ...r, tipo_oggetto: 'KIT' })));
    }

    // Se raggruppamento attivo, per i kit lasciamo tutto invariato (non raggruppiamo)
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
  // ... invariato
});

module.exports = router;