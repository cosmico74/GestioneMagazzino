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
      // 1. Articoli in magazzino
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

      // Se raggruppamento attivo, aggrega per codice_modello, descrizione, lunghezza, magazzino
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
          // Raccolgo le sigle (da fare in una seconda query, per ora mettiamo vuoto)
        });
        // Per le sigle, facciamo una seconda query per recuperarle per ogni gruppo
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
        // In modalità dettaglio, aggiungiamo campo sigle vuoto
        rowsMag = rowsMag.map(row => ({ ...row, sigle: '' }));
      }

      risultati = risultati.concat(rowsMag.map(r => ({ ...r, tipo_oggetto: 'ARTICOLO' })));

      // 2. Articoli assegnati (in carico_sintesi)
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
        // Per le sigle, query
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

    // --- KIT --- (nessun raggruppamento, solo filtri)
    if (includeKit) {
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
        // Per i kit, la lunghezza è nel dettaglio, quindi filtro su lunghezza_sci (sottoquery)
        sqlKitMagazzino += ' AND EXISTS (SELECT 1 FROM kit_dettaglio kd LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id WHERE kd.kit_id = k.id AND kd.tipo_articolo = "SCI" AND a.lunghezza LIKE ?)';
        paramsKitMag.push(`%${filtro_lunghezza}%`);
      }
      sqlKitMagazzino += ' ORDER BY k.codice_kit';
      const [rowsKitMag] = await pool.query(sqlKitMagazzino, paramsKitMag);
      risultati = risultati.concat(rowsKitMag.map(r => ({ ...r, tipo_oggetto: 'KIT' })));

      // Kit assegnati
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