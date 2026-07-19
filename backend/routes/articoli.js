const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');

// ============================================================
// HELPER: ricalcola quantita_totale (somma sigle)
// ============================================================
async function ricalcolaQuantitaTotale(connection, articoloId) {
  try {
    const [sumRows] = await connection.query(
      'SELECT COALESCE(SUM(quantita), 0) AS totale FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1',
      [articoloId]
    );
    const nuovoTotale = sumRows[0].totale || 0;
    await connection.query(
      'UPDATE articoli SET quantita_totale = ?, data_modifica = NOW() WHERE articolo_id = ?',
      [nuovoTotale, articoloId]
    );
    return nuovoTotale;
  } catch (err) {
    console.error('❌ Errore in ricalcolaQuantitaTotale:', err);
    throw err;
  }
}

// ============================================================
// HELPER: verifica se l'utente può usare un magazzino
// ============================================================
async function canUserUseMagazzino(userId, userRole, magazzinoId) {
  if (userRole === 'admin') return true;
  const [user] = await db.query('SELECT riferimento_id FROM utenti WHERE id = ?', [userId]);
  if (!user.length || !user[0].riferimento_id) return false;
  const soggettoId = user[0].riferimento_id;
  const [rows] = await db.query(
    'SELECT 1 FROM soggetti_magazzini WHERE soggetto_id = ? AND magazzino_id = ?',
    [soggettoId, magazzinoId]
  );
  return rows.length > 0;
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
        (COALESCE(a.quantita_totale, 0) - COALESCE(a.quantita_in_kit, 0) - COALESCE(a.quantita_obsoleta, 0) - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) AS GIACENZA_REALE,
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
      sql += ' AND (COALESCE(a.quantita_totale, 0) - COALESCE(a.quantita_in_kit, 0) - COALESCE(a.quantita_obsoleta, 0) - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = \'ARTICOLO\' AND oggetto_id = a.articolo_id), 0)) >= ?';
      params.push(req.query.min_giacenza);
    }
    const [rows] = await db.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('❌ Errore GET /articoli:', err);
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
        (COALESCE(a.quantita_totale, 0) - COALESCE(a.quantita_in_kit, 0) - COALESCE(a.quantita_obsoleta, 0) - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) AS GIACENZA_REALE
      FROM articoli a
      WHERE a.articolo_id = ?
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('❌ Errore GET /articoli/:id:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// CRUD SIGLE - VERSIONE CON RIATTIVAZIONE E CONTROLLO RIDUZIONE
// ============================================================
router.get('/:id/sigle', verifyToken, async (req, res) => {
  try {
    const [sigle] = await db.query(
      `SELECT s.* 
       FROM sigle_articoli s
       WHERE s.articolo_id = ? AND s.attivo = 1
       ORDER BY s.sigla`,
      [req.params.id]
    );

    for (const s of sigle) {
      try {
        const [inKit] = await db.query(
          'SELECT COALESCE(SUM(quantita), 0) AS totale FROM kit_dettaglio WHERE sigla_id = ?',
          [s.id]
        );
        const [assegnata] = await db.query(
          'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE sigla_id = ? AND tipo_oggetto = ?',
          [s.id, 'ARTICOLO']
        );
        s.giacenza = s.quantita - inKit[0].totale - assegnata[0].totale;
      } catch (calcErr) {
        console.warn(`⚠️ Errore nel calcolo giacenza per sigla ${s.id}:`, calcErr.message);
        s.giacenza = s.quantita;
      }
    }

    res.json(sigle);
  } catch (err) {
    console.error('❌ Errore GET /sigle:', err);
    res.status(500).json({ error: 'Errore nel recupero delle sigle', details: err.message });
  }
});

router.post('/:id/sigle', verifyToken, async (req, res) => {
  const { sigla, lunghezza, durezza, codice_modello, note, quantita } = req.body;
  if (!sigla) return res.status(400).json({ error: 'Sigla obbligatoria' });

  const quantitaVal = quantita || 0;
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [existing] = await connection.query(
      'SELECT id, attivo FROM sigle_articoli WHERE articolo_id = ? AND sigla = ?',
      [req.params.id, sigla]
    );

    if (existing.length > 0) {
      if (existing[0].attivo === 1) {
        await connection.rollback();
        return res.status(400).json({ error: 'Sigla già esistente per questo articolo' });
      } else {
        await connection.query(
          `UPDATE sigle_articoli 
           SET lunghezza = ?, durezza = ?, codice_modello = ?, note = ?, quantita = ?, quantita_austria = ?, attivo = 1
           WHERE id = ?`,
          [lunghezza || null, durezza || null, codice_modello || null, note || null, quantitaVal, quantitaVal, existing[0].id]
        );
        console.log('♻️ Sigla riattivata:', { articolo_id: req.params.id, sigla, id: existing[0].id });
      }
    } else {
      console.log('📝 Inserimento sigla:', {
        articolo_id: req.params.id,
        sigla,
        quantita: quantitaVal,
        quantita_austria: quantitaVal
      });
      await connection.query(
        `INSERT INTO sigle_articoli (articolo_id, sigla, lunghezza, durezza, codice_modello, note, quantita, quantita_austria, attivo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [req.params.id, sigla, lunghezza || null, durezza || null, codice_modello || null, note || null, quantitaVal, quantitaVal]
      );
    }

    await ricalcolaQuantitaTotale(connection, req.params.id);
    await connection.commit();

    res.json({ success: true, message: 'Sigla aggiunta con successo' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore POST /sigle:', err);
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
    console.error('❌ Errore PUT /sigle/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PUT /sigle/:id/quantita - CON CONTROLLO RIDUZIONE E LOG (versione tollerante)
// ============================================================
router.put('/sigle/:id/quantita', verifyToken, async (req, res) => {
  console.log('🔍 PUT /sigle/:id/quantita - body ricevuto:', req.body);
  const { quantita } = req.body;

  // Converti a numero: se è stringa vuota o null, diventa 0
  const quantitaNum = Number(quantita);
  if (isNaN(quantitaNum) || !Number.isInteger(quantitaNum) || quantitaNum < 0) {
    return res.status(400).json({
      error: 'Quantità non valida',
      received: quantita,
      message: 'Invia un numero intero >= 0 (o stringa vuota per 0)'
    });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Recupera l'articolo_id della sigla
    const [sigla] = await connection.query('SELECT articolo_id FROM sigle_articoli WHERE id = ?', [req.params.id]);
    if (!sigla.length) throw new Error('Sigla non trovata');
    const articoloId = sigla[0].articolo_id;

    // Calcola quanto è già usato nei kit
    const [usedInKit] = await connection.query(
      'SELECT COALESCE(SUM(quantita), 0) AS totale FROM kit_dettaglio WHERE sigla_id = ?',
      [req.params.id]
    );
    // Calcola quanto è già assegnato (carico_sintesi)
    const [assegnato] = await connection.query(
      'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE sigla_id = ? AND tipo_oggetto = ?',
      [req.params.id, 'ARTICOLO']
    );
    const impegnato = usedInKit[0].totale + assegnato[0].totale;

    // Se la nuova quantità è inferiore all'impegnato, blocca
    if (quantitaNum < impegnato) {
      await connection.rollback();
      return res.status(400).json({
        error: `Impossibile ridurre la sigla: ${impegnato} unità sono già impegnate (${usedInKit[0].totale} in kit, ${assegnato[0].totale} assegnate)`
      });
    }

    // Aggiorna la quantità
    await connection.query('UPDATE sigle_articoli SET quantita = ? WHERE id = ?', [quantitaNum, req.params.id]);

    // Ricalcola la quantita_totale dell'articolo
    await ricalcolaQuantitaTotale(connection, articoloId);

    await connection.commit();
    res.json({ success: true, message: 'Quantità aggiornata' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore PUT /sigle/quantita:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

router.put('/sigle/:id/austria', verifyToken, async (req, res) => {
  const { quantita_austria } = req.body;
  if (quantita_austria === undefined || quantita_austria < 0) {
    return res.status(400).json({ error: 'Quantità Austria non valida' });
  }
  try {
    await db.query('UPDATE sigle_articoli SET quantita_austria = ? WHERE id = ?', [quantita_austria, req.params.id]);
    res.json({ success: true, message: 'Quantità Austria aggiornata' });
  } catch (err) {
    console.error('❌ Errore PUT /sigle/austria:', err);
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
    console.error('❌ Errore DELETE /sigle:', err);
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

  if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzino))) {
    return res.status(403).json({ success: false, message: 'Magazzino non autorizzato' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

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
      quantita || 0,
      versione || '1.0',
      'Disponibile',
      now, now,
      note || '',
      codiceModello || null,
      invAustria
    ]);

    await connection.query(
      'INSERT INTO sigle_articoli (articolo_id, sigla, quantita, quantita_austria) VALUES (?, \'NA\', ?, ?)',
      [newId, quantita || 0, quantita || 0]
    );

    await ricalcolaQuantitaTotale(connection, newId);
    await connection.commit();

    res.json({ success: true, message: 'Articolo creato con successo', id: newId, codice });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore POST /articoli:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// PUT /api/articoli/:id
// ============================================================
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { descrizione, lunghezza, durezza, quantita_totale, quantita_obsoleta, versione, stato, note, codiceModello,
          magazzino, settore, categoria, marca, inventario_austria } = req.body;

  if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzino))) {
    return res.status(403).json({ success: false, message: 'Magazzino non autorizzato' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    if (quantita_totale !== undefined) {
      const [sigle] = await connection.query(
        'SELECT id, sigla FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1',
        [id]
      );
      if (sigle.length === 1 && sigle[0].sigla === 'NA') {
        await connection.query(
          'UPDATE sigle_articoli SET quantita = ?, quantita_austria = ? WHERE id = ?',
          [quantita_totale, quantita_totale, sigle[0].id]
        );
        await ricalcolaQuantitaTotale(connection, id);
      }
    }

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
    console.error('❌ Errore PUT /articoli:', err);
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
    console.error('❌ Errore DELETE /articoli:', err);
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
    console.error('❌ Errore POST /obsoleto:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// VALORI PER DATALIST
// ============================================================
router.get('/valori/:campo', verifyToken, async (req, res) => {
  const campo = req.params.campo;
  const map = { descrizioni: 'descrizione', lunghezze: 'lunghezza', durezze: 'durezza', modelli: 'codice_modello' };
  const col = map[campo] || campo;
  let sql = `SELECT DISTINCT ${col} AS ${col} FROM articoli WHERE ${col} IS NOT NULL AND ${col} != ''`;
  const params = [];

  if (req.query.magazzino) { sql += ' AND magazzino = ?'; params.push(req.query.magazzino); }
  if (req.query.settore) { sql += ' AND settore = ?'; params.push(req.query.settore); }
  if (req.query.categoria) { sql += ' AND categoria = ?'; params.push(req.query.categoria); }
  if (req.query.marca) { sql += ' AND marca = ?'; params.push(req.query.marca); }

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
module.exports.canUserUseMagazzino = canUserUseMagazzino;