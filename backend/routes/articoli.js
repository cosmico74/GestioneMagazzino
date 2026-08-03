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
// 🔥 HELPER: verifica duplicati su (descrizione, lunghezza, season_status_id, variante)
// ============================================================
async function checkDuplicate(connection, descrizione, lunghezza, seasonStatusId, variante, excludeId = null) {
  let sql = `
    SELECT articolo_id FROM articoli 
    WHERE descrizione = ? 
      AND (lunghezza = ? OR (lunghezza IS NULL AND ? IS NULL))
      AND (season_status_id = ? OR (season_status_id IS NULL AND ? IS NULL))
      AND (variante = ? OR (variante IS NULL AND ? IS NULL))
  `;
  const params = [descrizione, lunghezza, lunghezza, seasonStatusId, seasonStatusId, variante, variante];

  if (excludeId) {
    sql += ' AND articolo_id != ?';
    params.push(excludeId);
  }

  const [rows] = await connection.query(sql, params);
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
// HELPER: registra audit log
// ============================================================
async function registraAudit(connection, tabella, operazione, rigaId, datiPrima, datiDopo, utenteId) {
  await connection.query(
    `INSERT INTO audit_log (tabella, operazione, riga_id, dati_prima, dati_dopo, utente_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tabella, operazione, rigaId, JSON.stringify(datiPrima), JSON.stringify(datiDopo), utenteId]
  );
}

// ============================================================
// GET /api/articoli - con filtro settore
// ============================================================
router.get('/', verifyToken, async (req, res) => {
  try {
    let sql = `
      SELECT a.*,
        ss.nome AS season_status_nome,
        (COALESCE(a.quantita_totale, 0) - COALESCE(a.quantita_in_kit, 0) - COALESCE(a.quantita_obsoleta, 0) - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) AS GIACENZA_REALE,
        CASE 
          WHEN (COALESCE(a.quantita_totale, 0) - COALESCE(a.quantita_in_kit, 0) - COALESCE(a.quantita_obsoleta, 0) - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) <= 0 THEN 'Esaurito'
          ELSE 'Disponibile'
        END AS stato,
        m.nome AS magazzino_nome,
        s.nome AS settore_nome,
        c.nome AS categoria_nome,
        mar.nome AS marca_nome,
        u1.username AS creato_da_username,
        u2.username AS modificato_da_username
      FROM articoli a
      LEFT JOIN magazzini m ON a.magazzino = m.magazzino_id
      LEFT JOIN settori s ON a.settore = s.settore_id
      LEFT JOIN categorie c ON a.categoria = c.categoria_id
      LEFT JOIN marche mar ON a.marca = mar.marca_id
      LEFT JOIN season_status ss ON a.season_status_id = ss.id
      LEFT JOIN utenti u1 ON a.creato_da = u1.id
      LEFT JOIN utenti u2 ON a.modificato_da = u2.id
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
    if (req.query.variante) { sql += ' AND a.variante LIKE ?'; params.push(`%${req.query.variante}%`); }
    if (req.query.season_status_id) { sql += ' AND a.season_status_id = ?'; params.push(req.query.season_status_id); }
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
        ss.nome AS season_status_nome,
        (COALESCE(a.quantita_totale, 0) - COALESCE(a.quantita_in_kit, 0) - COALESCE(a.quantita_obsoleta, 0) - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) AS GIACENZA_REALE,
        CASE 
          WHEN (COALESCE(a.quantita_totale, 0) - COALESCE(a.quantita_in_kit, 0) - COALESCE(a.quantita_obsoleta, 0) - COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) <= 0 THEN 'Esaurito'
          ELSE 'Disponibile'
        END AS stato
      FROM articoli a
      LEFT JOIN season_status ss ON a.season_status_id = ss.id
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
// CRUD SIGLE (invariato)
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

    let siglaId;
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
        siglaId = existing[0].id;
        console.log('♻️ Sigla riattivata:', { articolo_id: req.params.id, sigla, id: existing[0].id });
      }
    } else {
      console.log('📝 Inserimento sigla:', {
        articolo_id: req.params.id,
        sigla,
        quantita: quantitaVal,
        quantita_austria: quantitaVal
      });
      const [result] = await connection.query(
        `INSERT INTO sigle_articoli (articolo_id, sigla, lunghezza, durezza, codice_modello, note, quantita, quantita_austria, attivo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [req.params.id, sigla, lunghezza || null, durezza || null, codice_modello || null, note || null, quantitaVal, quantitaVal]
      );
      siglaId = result.insertId;
    }

    await ricalcolaQuantitaTotale(connection, req.params.id);

    const [newSigla] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [siglaId]);
    await registraAudit(connection, 'sigle_articoli', 'CREAZIONE', siglaId, null, newSigla[0], req.userId);

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

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [oldRows] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
    if (!oldRows.length) throw new Error('Sigla non trovata');
    const oldData = oldRows[0];

    await connection.query(sql, values);

    const [newRows] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
    const newData = newRows[0];

    await registraAudit(connection, 'sigle_articoli', 'MODIFICA', req.params.id, oldData, newData, req.userId);

    await connection.commit();
    res.json({ success: true, message: 'Sigla aggiornata' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore PUT /sigle/:id:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

router.put('/sigle/:id/quantita', verifyToken, async (req, res) => {
  console.log('🔍 PUT /sigle/:id/quantita - body ricevuto:', req.body);
  const { quantita } = req.body;

  const quantitaNum = Number(quantita);
  if (isNaN(quantitaNum) || !Number.isInteger(quantitaNum) || quantitaNum < 0) {
    return res.status(400).json({
      error: 'Quantità non valida',
      received: quantita,
      message: 'Invia un numero intero >= 0'
    });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [oldRows] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
    if (!oldRows.length) throw new Error('Sigla non trovata');
    const oldData = oldRows[0];
    const articoloId = oldData.articolo_id;

    if (quantitaNum > oldData.quantita) {
      console.log('📈 Aumento quantità: da', oldData.quantita, 'a', quantitaNum, '- nessun controllo');
      await connection.query('UPDATE sigle_articoli SET quantita = ? WHERE id = ?', [quantitaNum, req.params.id]);
      
      const [newRows] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
      const newData = newRows[0];

      await registraAudit(connection, 'sigle_articoli', 'MODIFICA', req.params.id, oldData, newData, req.userId);
      await ricalcolaQuantitaTotale(connection, articoloId);

      await connection.commit();
      return res.json({ success: true, message: 'Quantità aggiornata (aumento)' });
    }

    const [usedInKit] = await connection.query(
      'SELECT COALESCE(SUM(quantita), 0) AS totale FROM kit_dettaglio WHERE sigla_id = ?',
      [req.params.id]
    );
    const [assegnato] = await connection.query(
      'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE sigla_id = ? AND tipo_oggetto = ?',
      [req.params.id, 'ARTICOLO']
    );
    const impegnato = usedInKit[0].totale + assegnato[0].totale;

    console.log('🔍 DEBUG riduzione sigla:', {
      siglaId: req.params.id,
      siglaNome: oldData.sigla,
      articoloId: oldData.articolo_id,
      quantitaAttuale: oldData.quantita,
      nuovaQuantita: quantitaNum,
      inKit: usedInKit[0].totale,
      assegnato: assegnato[0].totale,
      impegnato: impegnato
    });

    if (quantitaNum < impegnato) {
      await connection.rollback();
      return res.status(400).json({
        error: `Impossibile ridurre la sigla: ${impegnato} unità sono già impegnate (${usedInKit[0].totale} in kit, ${assegnato[0].totale} assegnate)`
      });
    }

    await connection.query('UPDATE sigle_articoli SET quantita = ? WHERE id = ?', [quantitaNum, req.params.id]);

    const [newRows] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
    const newData = newRows[0];

    await registraAudit(connection, 'sigle_articoli', 'MODIFICA', req.params.id, oldData, newData, req.userId);
    await ricalcolaQuantitaTotale(connection, articoloId);

    await connection.commit();
    res.json({ success: true, message: 'Quantità aggiornata (riduzione)' });
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

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [oldRows] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
    if (!oldRows.length) throw new Error('Sigla non trovata');
    const oldData = oldRows[0];

    await connection.query('UPDATE sigle_articoli SET quantita_austria = ? WHERE id = ?', [quantita_austria, req.params.id]);

    const [newRows] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
    const newData = newRows[0];

    await registraAudit(connection, 'sigle_articoli', 'MODIFICA', req.params.id, oldData, newData, req.userId);

    await connection.commit();
    res.json({ success: true, message: 'Quantità Austria aggiornata' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore PUT /sigle/austria:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

router.delete('/sigle/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [sigla] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [req.params.id]);
    if (!sigla.length) throw new Error('Sigla non trovata');
    
    const [count] = await connection.query('SELECT COUNT(*) as cnt FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1', [sigla[0].articolo_id]);
    if (count[0].cnt === 1) throw new Error('Impossibile eliminare l\'unica sigla dell\'articolo');
    
    await registraAudit(connection, 'sigle_articoli', 'ELIMINAZIONE', req.params.id, sigla[0], null, req.userId);
    
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
// POST /api/articoli - con controllo duplicati
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  const { descrizione, magazzino, settore, categoria, marca, lunghezza, durezza, quantita, versione, note, codiceModello, inventario_austria, variante, season_status_id } = req.body;

  if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzino))) {
    return res.status(403).json({ success: false, message: 'Magazzino non autorizzato' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 🔥 CONTROLLO DUPLICATI
    const exists = await checkDuplicate(connection, descrizione, lunghezza, season_status_id || null, variante || null);
    if (exists) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Esiste già un articolo con la stessa descrizione, lunghezza, season status e variante.'
      });
    }

    const [[{ maxId }]] = await connection.query('SELECT MAX(articolo_id) as maxId FROM articoli');
    const newId = (maxId || 0) + 1;

    const codice = generateArticleCode({ categoriaNome: '', marcaNome: '', lunghezza, durezza }, newId);
    const descrizioneCompleta = buildDescrizioneCompleta(descrizione, lunghezza, durezza);
    const now = db.now();
    const invAustria = (inventario_austria !== undefined) ? (inventario_austria ? 1 : 0) : 1;

    await connection.query(`
      INSERT INTO articoli (articolo_id, codice, descrizione, descrizione_completa, magazzino, settore, categoria, marca,
        lunghezza, durezza, quantita_totale, quantita_in_kit, quantita_obsoleta, versione, stato, data_inserimento, data_modifica, note, codice_modello, inventario_austria, creato_da, modificato_da,
        variante, season_status_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      invAustria,
      req.userId,
      req.userId,
      variante || null,
      season_status_id || null
    ]);

    const [siglaResult] = await connection.query(
      'INSERT INTO sigle_articoli (articolo_id, sigla, quantita, quantita_austria) VALUES (?, \'NA\', ?, ?)',
      [newId, quantita || 0, quantita || 0]
    );
    const siglaId = siglaResult.insertId;

    await ricalcolaQuantitaTotale(connection, newId);

    const [newRow] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [newId]);
    await registraAudit(connection, 'articoli', 'CREAZIONE', newId, null, newRow[0], req.userId);

    const [newSigla] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [siglaId]);
    await registraAudit(connection, 'sigle_articoli', 'CREAZIONE', siglaId, null, newSigla[0], req.userId);

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
// PUT /api/articoli/:id - con controllo duplicati
// ============================================================
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { descrizione, lunghezza, durezza, quantita_totale, quantita_obsoleta, versione, stato, note, codiceModello,
          magazzino, settore, categoria, marca, inventario_austria, variante, season_status_id } = req.body;

  if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzino))) {
    return res.status(403).json({ success: false, message: 'Magazzino non autorizzato' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 🔥 CONTROLLO DUPLICATI (escludendo l'articolo corrente)
    const exists = await checkDuplicate(connection, descrizione, lunghezza, season_status_id || null, variante || null, id);
    if (exists) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Esiste già un altro articolo con la stessa descrizione, lunghezza, season status e variante.'
      });
    }

    const [oldRow] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id]);

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
        const [oldSigla] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [sigle[0].id]);
        const [newSigla] = await connection.query('SELECT * FROM sigle_articoli WHERE id = ?', [sigle[0].id]);
        await registraAudit(connection, 'sigle_articoli', 'MODIFICA', sigle[0].id, oldSigla[0], newSigla[0], req.userId);
        await ricalcolaQuantitaTotale(connection, id);
      }
    }

    const now = db.now();
    const invAustria = (inventario_austria !== undefined) ? (inventario_austria ? 1 : 0) : 1;
    await connection.query(`
      UPDATE articoli SET 
        descrizione = ?, lunghezza = ?, durezza = ?, quantita_totale = ?, quantita_obsoleta = ?,
        versione = ?, stato = ?, note = ?, codice_modello = ?, magazzino = ?, settore = ?, categoria = ?, marca = ?,
        inventario_austria = ?, data_modifica = NOW(), modificato_da = ?,
        variante = ?, season_status_id = ?
      WHERE articolo_id = ?
    `, [descrizione, lunghezza, durezza, quantita_totale, quantita_obsoleta, versione, stato, note, codiceModello,
        magazzino, settore, categoria, marca, invAustria, req.userId,
        variante || null, season_status_id || null, id]);

    const [newRow] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id]);
    await registraAudit(connection, 'articoli', 'MODIFICA', id, oldRow[0], newRow[0], req.userId);

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
  const id = req.params.id;

  if (!id || isNaN(parseInt(id))) {
    return res.status(400).json({ success: false, message: 'ID articolo non valido' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [oldRow] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [id]);
    if (oldRow.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Articolo non trovato' });
    }

    const [inKit] = await connection.query(
      'SELECT COUNT(*) AS count FROM kit_dettaglio WHERE articolo_id = ?',
      [id]
    );
    if (inKit[0].count > 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Impossibile eliminare: l'articolo è utilizzato in ${inKit[0].count} kit. Rimuovilo dai kit prima di eliminarlo.`
      });
    }

    const [assegnato] = await connection.query(
      'SELECT SUM(quantita) AS totale FROM carico_sintesi WHERE tipo_oggetto = "ARTICOLO" AND oggetto_id = ? AND quantita > 0',
      [id]
    );
    if (assegnato[0].totale && parseInt(assegnato[0].totale) > 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Impossibile eliminare: l'articolo è ancora assegnato (${assegnato[0].totale} unità in carico). Rientra l'articolo prima di eliminarlo.`
      });
    }

    await registraAudit(connection, 'articoli', 'ELIMINAZIONE', id, oldRow[0], null, req.userId);
    await connection.query('DELETE FROM sigle_articoli WHERE articolo_id = ?', [id]);
    await connection.query('DELETE FROM articoli WHERE articolo_id = ?', [id]);

    await connection.commit();
    res.json({ success: true, message: 'Articolo eliminato con successo' });
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
  const map = { 
    descrizioni: 'descrizione', 
    lunghezze: 'lunghezza', 
    durezze: 'durezza', 
    modelli: 'codice_modello',
    varianti: 'variante'
  };
  const col = map[campo] || campo;
  let sql = `SELECT DISTINCT ${col} AS ${col} FROM articoli WHERE ${col} IS NOT NULL AND ${col} != ''`;
  const params = [];

  if (req.query.magazzino) { sql += ' AND magazzino = ?'; params.push(req.query.magazzino); }
  if (req.query.settore) { sql += ' AND settore = ?'; params.push(req.query.settore); }
  if (req.query.categoria) { sql += ' AND categoria = ?'; params.push(req.query.categoria); }
  if (req.query.marca) { sql += ' AND marca = ?'; params.push(req.query.marca); }

  const filterableFields = ['descrizione', 'codice_modello', 'lunghezza', 'durezza', 'variante'];
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

router.get('/valori/categorie', verifyToken, async (req, res) => {
  let sql = `SELECT DISTINCT categoria AS categoria FROM articoli WHERE categoria IS NOT NULL`;
  const params = [];
  if (req.query.settore) {
    sql += ' AND settore = ?';
    params.push(req.query.settore);
  }
  if (req.query.magazzino) {
    sql += ' AND magazzino = ?';
    params.push(req.query.magazzino);
  }
  sql += ' ORDER BY categoria';
  const [rows] = await db.query(sql, params);
  res.json(rows);
});

router.get('/valori/sigle', verifyToken, async (req, res) => {
  try {
    const params = [];
    let sql = `
      SELECT DISTINCT codice_modello AS sigla FROM articoli 
      WHERE codice_modello IS NOT NULL AND codice_modello != ''
    `;
    if (req.query.magazzino) {
      sql += ' AND magazzino = ?';
      params.push(req.query.magazzino);
    }
    if (req.query.settore) {
      sql += ' AND settore = ?';
      params.push(req.query.settore);
    }
    if (req.query.lunghezza) {
      sql += ' AND lunghezza = ?';
      params.push(req.query.lunghezza);
    }
    if (req.query.descrizione) {
      sql += ' AND descrizione LIKE ?';
      params.push(`%${req.query.descrizione}%`);
    }
    sql += ' ORDER BY sigla';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ Errore /valori/sigle:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/valori/lunghezze', verifyToken, async (req, res) => {
  try {
    const params = [];
    let sql = `
      SELECT DISTINCT lunghezza FROM articoli 
      WHERE lunghezza IS NOT NULL AND lunghezza != ''
    `;
    if (req.query.magazzino) {
      sql += ' AND magazzino = ?';
      params.push(req.query.magazzino);
    }
    if (req.query.settore) {
      sql += ' AND settore = ?';
      params.push(req.query.settore);
    }
    if (req.query.descrizione) {
      sql += ' AND descrizione LIKE ?';
      params.push(`%${req.query.descrizione}%`);
    }
    if (req.query.sigla) {
      sql += ' AND codice_modello LIKE ?';
      params.push(`%${req.query.sigla}%`);
    }
    sql += ' ORDER BY lunghezza';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ Errore /valori/lunghezze:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/valori/attacchi', verifyToken, async (req, res) => {
  try {
    let sql = `
      SELECT DISTINCT 
        a.articolo_id, 
        a.descrizione, 
        a.lunghezza
      FROM articoli a
      INNER JOIN categorie c ON a.categoria = c.categoria_id
      WHERE LOWER(c.nome) = 'attacchi' 
        AND a.quantita_totale > 0
        AND (a.quantita_totale - a.quantita_in_kit - a.quantita_obsoleta - 
             COALESCE((SELECT SUM(quantita) FROM carico_sintesi WHERE tipo_oggetto = 'ARTICOLO' AND oggetto_id = a.articolo_id), 0)) > 0
      ORDER BY a.descrizione
    `;
    const params = [];
    if (req.query.magazzino) {
      sql = sql.replace('ORDER BY a.descrizione', 'AND a.magazzino = ? ORDER BY a.descrizione');
      params.push(req.query.magazzino);
    }
    if (req.query.settore) {
      sql = sql.replace('ORDER BY a.descrizione', 'AND a.settore = ? ORDER BY a.descrizione');
      params.push(req.query.settore);
    }
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ Errore /valori/attacchi:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/articoli/:id/ricalcola - Forza ricalcolo quantità totale
// ============================================================
router.post('/:id/ricalcola', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    const nuovaQuantita = await ricalcolaQuantitaTotale(connection, req.params.id);
    await connection.commit();
    res.json({ success: true, message: 'Quantità ricalcolata', nuovaQuantita });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore ricalcolo:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;
module.exports.ricalcolaQuantitaTotale = ricalcolaQuantitaTotale;
module.exports.canUserUseMagazzino = canUserUseMagazzino;
module.exports.checkDuplicate = checkDuplicate;