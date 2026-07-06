const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');

// ============================================================
// HELPER: ricalcola quantita_totale (somma sigle)
// ============================================================
async function ricalcolaQuantitaTotale(connection, articoloId) {
  const [sumRows] = await connection.query(
    'SELECT SUM(quantita) AS totale FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1',
    [articoloId]
  );
  const nuovoTotale = sumRows[0].totale || 0;
  await connection.query(
    'UPDATE articoli SET quantita_totale = ?, data_modifica = ? WHERE articolo_id = ?',
    [nuovoTotale, db.now(), articoloId]
  );
}

// ============================================================
// HELPER: genera codice e descrizione
// ============================================================
function generateArticleCode(articleData, id) {
  const cat = (articleData.categoriaNome || 'ART').substring(0, 3).toUpperCase();
  const mar = (articleData.marcaNome || 'GEN').substring(0, 3).toUpperCase();
  let code = `${cat}-${mar}-${id.toString().padStart(4, '0')}`;
  if (articleData.lunghezza) code += `-L${articleData.lunghezza}`;
  if (articleData.durezza) code += `-D${articleData.durezza}`;
  return code;
}
function buildDescrizioneCompleta(desc, lung, dur) {
  return [desc, lung, dur].filter(v => v && v !== '0' && v !== 'N/A').join(' ');
}

// ============================================================
// GET /api/articoli
// ============================================================
router.get('/', verifyToken, async (req, res) => {
  try {
    let sql = `
      SELECT a.*,
        (a.quantita_totale - a.quantita_in_kit - a.quantita_obsoleta - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) AS GIACENZA_REALE,
        m.nome AS magazzino_nome,
        s.nome AS settore_nome,
        c.nome AS categoria_nome,
        mar.nome AS marca_nome
      FROM articoli a
      LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
      LEFT JOIN settori s ON a.settore = s.settore_id
      LEFT JOIN categorie c ON a.categoria = c.categoria_id
      LEFT JOIN marche mar ON a.marca = mar.marca_id
      WHERE 1=1
    `;
    const params = [];
    if (req.query.magazzino) { sql += ' AND a.magazzino = ?'; params.push(req.query.magazzino); }
    if (req.query.settore) { sql += ' AND a.settore = ?'; params.push(req.query.settore); }
    if (req.query.categoria) { sql += ' AND a.categoria = ?'; params.push(req.query.categoria); }
    if (req.query.marca) { sql += ' AND a.marca = ?'; params.push(req.query.marca); }
    if (req.query.descrizione) { sql += ' AND a.descrizione LIKE ?'; params.push(`%${req.query.descrizione}%`); }
    if (req.query.lunghezza) { sql += ' AND a.lunghezza = ?'; params.push(req.query.lunghezza); }
    if (req.query.durezza) { sql += ' AND a.durezza = ?'; params.push(req.query.durezza); }
    if (req.query.codice_modello) { sql += ' AND a.codice_modello = ?'; params.push(req.query.codice_modello); }
    if (req.query.min_giacenza) {
      sql += ' AND (a.quantita_totale - a.quantita_in_kit - a.quantita_obsoleta - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = \'ARTICOLO\' AND oggetto_id = a.articolo_id), 0)) >= ?';
      params.push(req.query.min_giacenza);
    }
    const [rows] = await db.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Errore GET /articoli:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET /api/articoli/:id
// ============================================================
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT a.*,
        (a.quantita_totale - a.quantita_in_kit - a.quantita_obsoleta) AS GIACENZA_REALE
      FROM articoli a
      WHERE a.articolo_id = ?
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('Errore GET /articoli/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CRUD SIGLE (con quantita_austria = quantita di default)
// ============================================================
router.get('/:id/sigle', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*,
        (s.quantita - COALESCE((SELECT SUM(quantita) FROM kit_dettaglio WHERE sigla_id = s.id), 0) - 
         COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE sigla_id = s.id AND tipo_oggetto = 'ARTICOLO'), 0)) AS giacenza
      FROM sigle_articoli s
      WHERE s.articolo_id = ? AND s.attivo = 1
      ORDER BY s.sigla
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error('Errore GET /sigle:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/sigle', verifyToken, async (req, res) => {
  const { sigla, lunghezza, durezza, codice_modello, note, quantita } = req.body;
  if (!sigla) return res.status(400).json({ error: 'Sigla obbligatoria' });
  const quantitaAustria = quantita || 0; // default: uguale a quantita
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO sigle_articoli (articolo_id, sigla, lunghezza, durezza, codice_modello, note, quantita, quantita_austria, attivo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [req.params.id, sigla, lunghezza || null, durezza || null, codice_modello || null, note || null, quantita || 0, quantitaAustria]
    );
    await ricalcolaQuantitaTotale(connection, req.params.id);
    await connection.commit();
    res.json({ success: true, message: 'Sigla aggiunta' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore POST /sigle:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

router.put('/sigle/:id', verifyToken, async (req, res) => {
  const { sigla, note, quantita_austria } = req.body;
  let updateFields = [];
  let values = [];
  if (sigla) {
    updateFields.push('sigla = ?');
    values.push(sigla);
  }
  if (note !== undefined) {
    updateFields.push('note = ?');
    values.push(note);
  }
  if (quantita_austria !== undefined) {
    updateFields.push('quantita_austria = ?');
    values.push(quantita_austria);
  }
  if (updateFields.length === 0) {
    return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  }
  values.push(req.params.id);
  const sql = `UPDATE sigle_articoli SET ${updateFields.join(', ')} WHERE id = ?`;
  try {
    await db.query(sql, values);
    res.json({ success: true, message: 'Sigla aggiornata' });
  } catch (err) {
    console.error('Errore PUT /sigle/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/sigle/:id/quantita', verifyToken, async (req, res) => {
  const { quantita } = req.body;
  if (quantita === undefined || quantita < 0) return res.status(400).json({ error: 'Quantità non valida' });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [sigla] = await connection.query('SELECT articolo_id FROM sigle_articoli WHERE id = ?', [req.params.id]);
    if (!sigla.length) throw new Error('Sigla non trovata');
    await connection.query('UPDATE sigle_articoli SET quantita = ? WHERE id = ?', [quantita, req.params.id]);
    await ricalcolaQuantitaTotale(connection, sigla[0].articolo_id);
    await connection.commit();
    res.json({ success: true, message: 'Quantità aggiornata' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore PUT /sigle/quantita:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// PUT /sigle/:id/austria – aggiorna solo la quantità Austria
// ============================================================
router.put('/sigle/:id/austria', verifyToken, async (req, res) => {
  const { quantita_austria } = req.body;
  if (quantita_austria === undefined || quantita_austria < 0) {
    return res.status(400).json({ error: 'Quantità Austria non valida' });
  }
  try {
    await db.query('UPDATE sigle_articoli SET quantita_austria = ? WHERE id = ?', [quantita_austria, req.params.id]);
    res.json({ success: true, message: 'Quantità Austria aggiornata' });
  } catch (err) {
    console.error('Errore PUT /sigle/austria:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sigle/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [sigla] = await connection.query('SELECT articolo_id FROM sigle_articoli WHERE id = ?', [req.params.id]);
    if (!sigla.length) throw new Error('Sigla non trovata');
    const [count] = await connection.query('SELECT COUNT(*) as cnt FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1', [sigla[0].articolo_id]);
    if (count[0].cnt === 1) throw new Error('Impossibile eliminare l\'unica sigla dell\'articolo');
    await connection.query('UPDATE sigle_articoli SET attivo = 0 WHERE id = ?', [req.params.id]);
    await ricalcolaQuantitaTotale(connection, sigla[0].articolo_id);
    await connection.commit();
    res.json({ success: true, message: 'Sigla eliminata' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore DELETE /sigle:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// POST /api/articoli
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  const { descrizione, magazzino, settore, categoria, marca, lunghezza, durezza, quantita, versione, note, codiceModello, inventario_austria } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query(`
      SELECT articolo_id FROM articoli
      WHERE magazzino = ? AND settore = ? AND categoria = ? AND marca = ?
        AND descrizione = ? AND COALESCE(lunghezza,'') = COALESCE(?,'') AND COALESCE(durezza,'') = COALESCE(?,'')
    `, [magazzino, settore, categoria, marca, descrizione, lunghezza, durezza]);
    if (existing.length) {
      const artId = existing[0].articolo_id;
      const [na] = await connection.query(
        'SELECT id FROM sigle_articoli WHERE articolo_id = ? AND sigla = \'NA\' AND attivo = 1',
        [artId]
      );
      if (na.length) {
        // Aggiorna sia quantita che quantita_austria (aggiungi la stessa quantità)
        await connection.query('UPDATE sigle_articoli SET quantita = quantita + ?, quantita_austria = quantita_austria + ? WHERE id = ?', [quantita, quantita, na[0].id]);
      } else {
        await connection.query('INSERT INTO sigle_articoli (articolo_id, sigla, quantita, quantita_austria) VALUES (?, \'NA\', ?, ?)', [artId, quantita, quantita]);
      }
      await ricalcolaQuantitaTotale(connection, artId);
      if (inventario_austria !== undefined) {
        await connection.query('UPDATE articoli SET inventario_austria = ? WHERE articolo_id = ?', [inventario_austria ? 1 : 0, artId]);
      }
      await connection.commit();
      return res.json({ success: true, message: 'Quantità aggiunta all\'articolo esistente', id: artId });
    }
    const [[{ maxId }]] = await connection.query('SELECT MAX(articolo_id) as maxId FROM articoli');
    const newId = (maxId || 0) + 1;
    const codice = generateArticleCode({ categoriaNome: '', marcaNome: '', lunghezza, durezza }, newId);
    const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
    const now = db.now();
    const invAustria = (inventario_austria !== undefined) ? (inventario_austria ? 1 : 0) : 1;
    await connection.query(`
      INSERT INTO articoli (articolo_id, codice, descrizione, descrizione_completa, magazzino, settore, categoria, marca,
        lunghezza, durezza, quantita_totale, quantita_in_kit, quantita_obsoleta, versione, stato, data_inserimento, data_modifica, note, codice_modello, inventario_austria)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)
    `, [
      newId, codice, descrizione, descrizioneCompleta,
      magazzino, settore, categoria, marca,
      lunghezza || '', durezza || '',
      quantita,
      versione || '1.0',
      'Disponibile',
      now, now,
      note || '',
      codiceModello || null,
      invAustria
    ]);
    // Inserisci sigla NA con quantita_austria = quantita
    await connection.query('INSERT INTO sigle_articoli (articolo_id, sigla, quantita, quantita_austria) VALUES (?, \'NA\', ?, ?)', [newId, quantita, quantita]);
    await ricalcolaQuantitaTotale(connection, newId);
    await connection.commit();
    res.json({ success: true, message: 'Articolo creato', id: newId, codice });
  } catch (err) {
    await connection.rollback();
    console.error('Errore POST /articoli:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// PUT /api/articoli/:id (con aggiornamento automatico sigla NA)
// ============================================================
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { descrizione, lunghezza, durezza, quantita_totale, quantita_obsoleta, versione, stato, note, codiceModello,
          magazzino, settore, categoria, marca, inventario_austria } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // --- AGGIUNTA: Se viene modificata quantita_totale, aggiorna la sigla NA se è unica ---
    if (quantita_totale !== undefined) {
      const [sigle] = await connection.query(
        'SELECT id, sigla FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1',
        [id]
      );
      // Se l'articolo ha una sola sigla attiva e questa è 'NA', aggiorna automaticamente
      if (sigle.length === 1 && sigle[0].sigla === 'NA') {
        await connection.query(
          'UPDATE sigle_articoli SET quantita = ?, quantita_austria = ? WHERE id = ?',
          [quantita_totale, quantita_totale, sigle[0].id]
        );
        await ricalcolaQuantitaTotale(connection, id);
      }
    }
    // --- FINE AGGIUNTA ---

    const now = db.now();
    const invAustria = (inventario_austria !== undefined) ? (inventario_austria ? 1 : 0) : 1;
    await connection.query(`
      UPDATE articoli SET 
        descrizione = ?, lunghezza = ?, durezza = ?, quantita_totale = ?, quantita_obsoleta = ?,
        versione = ?, stato = ?, note = ?, codice_modello = ?, magazzino = ?, settore = ?, categoria = ?, marca = ?,
        inventario_austria = ?, data_modifica = ?
      WHERE articolo_id = ?
    `, [descrizione, lunghezza, durezza, quantita_totale, quantita_obsoleta, versione, stato, note, codiceModello,
        magazzino, settore, categoria, marca, invAustria, now, id]);
    await connection.commit();
    res.json({ success: true, message: 'Articolo aggiornato' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore PUT /articoli:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// DELETE /api/articoli/:id
// ============================================================
router.delete('/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM kit_dettaglio WHERE articolo_id = ?', [req.params.id]);
    await connection.query('DELETE FROM sigle_articoli WHERE articolo_id = ?', [req.params.id]);
    await connection.query('DELETE FROM articoli WHERE articolo_id = ?', [req.params.id]);
    await connection.commit();
    res.json({ success: true, message: 'Articolo eliminato' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore DELETE /articoli:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// OBSOLESCENZA
// ============================================================
router.post('/:id/obsoleto', verifyToken, async (req, res) => {
  const { quantita, note } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [art] = await connection.query('SELECT quantita_totale, quantita_obsoleta FROM articoli WHERE articolo_id = ? FOR UPDATE', [req.params.id]);
    const disponibile = art[0].quantita_totale - (art[0].quantita_obsoleta || 0);
    if (disponibile < quantita) throw new Error('Quantità disponibile insufficiente');
    await connection.query('UPDATE articoli SET quantita_obsoleta = quantita_obsoleta + ? WHERE articolo_id = ?', [quantita, req.params.id]);
    await ricalcolaQuantitaTotale(connection, req.params.id);
    await connection.commit();
    res.json({ success: true, message: `${quantita} unità rese obsolete` });
  } catch (err) {
    await connection.rollback();
    console.error('Errore POST /obsoleto:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// VALORI PER DATALIST (con filtro incrociato)
// ============================================================
router.get('/valori/:campo', verifyToken, async (req, res) => {
  const campo = req.params.campo;
  const map = { descrizioni: 'descrizione', lunghezze: 'lunghezza', durezze: 'durezza', modelli: 'codice_modello' };
  const col = map[campo] || campo;
  let sql = `SELECT DISTINCT ${col} AS ${col} FROM articoli WHERE ${col} IS NOT NULL AND ${col} != ''`;
  const params = [];

  // Filtri comuni (magazzino, settore, categoria, marca)
  if (req.query.magazzino) { sql += ' AND magazzino = ?'; params.push(req.query.magazzino); }
  if (req.query.settore) { sql += ' AND settore = ?'; params.push(req.query.settore); }
  if (req.query.categoria) { sql += ' AND categoria = ?'; params.push(req.query.categoria); }
  if (req.query.marca) { sql += ' AND marca = ?'; params.push(req.query.marca); }

  // Filtri per gli altri campi (descrizione, codice_modello, lunghezza, durezza)
  // Escludiamo il campo corrente per evitare auto-filtro
  const filterableFields = ['descrizione', 'codice_modello', 'lunghezza', 'durezza'];
  for (const f of filterableFields) {
    if (f !== col && req.query[f]) {
      sql += ` AND ${f} = ?`;
      params.push(req.query[f]);
    }
  }

  sql += ` ORDER BY ${col}`;
  const [rows] = await db.query(sql, params);
  res.json(rows);
});

module.exports = router;
module.exports.ricalcolaQuantitaTotale = ricalcolaQuantitaTotale;