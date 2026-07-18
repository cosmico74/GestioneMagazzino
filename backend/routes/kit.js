const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');
const { canUserUseMagazzino } = require('./articoli');
const { aggiornaCaricoSintesi, getDisponibilitaSigla } = require('./assegnazioni');

console.log('✅ FILE KIT.JS CARICATO CORRETTAMENTE');

// ============================================================
// HELPER: aggiorna quantita_in_kit per un articolo
// ============================================================
async function ricalcolaQuantitaInKit(connection, articoloId) {
  const [sum] = await connection.query(
    'SELECT COALESCE(SUM(quantita), 0) AS totale FROM kit_dettaglio WHERE articolo_id = ?',
    [articoloId]
  );
  await connection.query(
    'UPDATE articoli SET quantita_in_kit = ? WHERE articolo_id = ?',
    [sum[0].totale, articoloId]
  );
}

async function aggiungiInKit(connection, articoloId, quantita) {
  await connection.query(
    'UPDATE articoli SET quantita_in_kit = quantita_in_kit + ? WHERE articolo_id = ?',
    [quantita, articoloId]
  );
}

async function rimuoviDaKit(connection, articoloId, quantita) {
  await connection.query(
    'UPDATE articoli SET quantita_in_kit = quantita_in_kit - ? WHERE articolo_id = ?',
    [quantita, articoloId]
  );
}

// ============================================================
// HELPER: genera descrizione kit (sci + attacco)
// ============================================================
async function generaDescrizioneKit(connection, sci, righe) {
  const { descrizione, lunghezza } = sci;
  const parti = [];
  for (const riga of righe) {
    const { attacco_id } = riga;
    const [attaccoRow] = await connection.query(
      'SELECT descrizione FROM articoli WHERE articolo_id = ?',
      [attacco_id]
    );
    const attaccoDesc = attaccoRow.length ? attaccoRow[0].descrizione : 'Attacco sconosciuto';
    let parte = `${descrizione} ${lunghezza || ''}`.trim();
    parte += ` + ${attaccoDesc}`;
    parti.push(parte);
  }
  return parti.join(' ; ');
}

// ============================================================
// GET /api/kit - Elenco kit
// ============================================================
router.get('/', verifyToken, async (req, res) => {
  try {
    const [kits] = await db.query(`
      SELECT k.*,
        (SELECT a.lunghezza FROM kit_dettaglio kd
         LEFT JOIN articoli a ON kd.articolo_id = a.articolo_id
         WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI'
         LIMIT 1) AS lunghezza_sci,
        (SELECT s.sigla FROM kit_dettaglio kd
         LEFT JOIN sigle_articoli s ON kd.sigla_id = s.id
         WHERE kd.kit_id = k.id AND kd.tipo_articolo = 'SCI'
         LIMIT 1) AS sigla_sci
      FROM kit k
      ORDER BY k.id DESC
    `);
    const risultato = kits.map(k => ({
      ...k,
      lunghezza_sci: k.lunghezza_sci || '',
      sigla_sci: k.sigla_sci || ''
    }));
    res.json(risultato);
  } catch (err) {
    console.error('❌ Errore GET /kit:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/kit/sigle-usate - Sigle già utilizzate in kit (deprecato)
// ============================================================
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
    console.error('❌ Errore GET /kit/sigle-usate:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/kit/:id - Dettaglio kit
// ============================================================
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [kit] = await db.query('SELECT * FROM kit WHERE id = ?', [req.params.id]);
    if (!kit.length) return res.status(404).json({ error: 'Kit non trovato' });
    
    const [dettagli] = await db.query(`
      SELECT d.*, a.descrizione AS articolo_descrizione, a.codice AS articolo_codice, s.sigla
      FROM kit_dettaglio d
      LEFT JOIN articoli a ON d.articolo_id = a.articolo_id
      LEFT JOIN sigle_articoli s ON d.sigla_id = s.id
      WHERE d.kit_id = ?
    `, [req.params.id]);
    
    res.json({ ...kit[0], dettagli });
  } catch (err) {
    console.error('❌ Errore GET /kit/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/kit - Crea un nuovo kit da magazzino
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  const { magazzino, sci_id, note, righe } = req.body;
  if (!magazzino || !sci_id || !righe || !righe.length) {
    return res.status(400).json({ success: false, message: 'Dati incompleti' });
  }

  if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzino))) {
    return res.status(403).json({ success: false, message: 'Magazzino non autorizzato' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [sci] = await connection.query('SELECT descrizione, lunghezza, durezza FROM articoli WHERE articolo_id = ?', [sci_id]);
    if (!sci.length) throw new Error('Sci non trovato');

    const [maxIdRow] = await connection.query('SELECT MAX(id) AS maxId FROM kit');
    const nextSeq = (maxIdRow[0].maxId || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${String(nextSeq).padStart(4, '0')}`;
    const descKit = await generaDescrizioneKit(connection, sci[0], righe);

    const now = db.now();
    const [kitRes] = await connection.query(
      'INSERT INTO kit (codice_kit, descrizione, quantita, magazzino, note, data_creazione, data_modifica) VALUES (?, ?, 0, ?, ?, ?, ?)',
      [codiceKit, descKit, magazzino, note || null, now, now]
    );
    const kitId = kitRes.insertId;

    let quantitaTotaleKit = 0;
    for (const riga of righe) {
      const { sigla_id, attacco_id, skistopper_id, quantita } = riga;
      if (!sigla_id || !attacco_id) throw new Error('Ogni riga deve avere sigla e attacco');

      await aggiungiInKit(connection, sci_id, quantita);
      await aggiungiInKit(connection, attacco_id, quantita);
      if (skistopper_id) {
        await aggiungiInKit(connection, skistopper_id, quantita);
      }

      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SCI\', ?, ?, ?)',
        [kitId, sci_id, sigla_id, quantita]
      );
      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'ATTACCHI\', ?, NULL, ?)',
        [kitId, attacco_id, quantita]
      );
      if (skistopper_id) {
        await connection.query(
          'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SKISTOPPER\', ?, NULL, ?)',
          [kitId, skistopper_id, quantita]
        );
      }
      quantitaTotaleKit += quantita;
    }

    await connection.query('UPDATE kit SET quantita = ? WHERE id = ?', [quantitaTotaleKit, kitId]);
    await connection.commit();
    res.json({ success: true, message: 'Kit creato con successo', kitId });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore creazione kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// POST /api/kit/da-carico - Crea kit da articoli in carico a un soggetto
// ============================================================
router.post('/da-carico', verifyToken, async (req, res) => {
  const { soggettoTipo, soggettoId, oggetti, destinazioneTipo, destinazioneId, magazzinoId, note } = req.body;
  if (!soggettoTipo || !soggettoId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Dati incompleti' });
  }
  if (!destinazioneTipo || !destinazioneId) {
    return res.status(400).json({ success: false, message: 'Destinazione obbligatoria' });
  }
  if (!magazzinoId) {
    return res.status(400).json({ success: false, message: 'Magazzino di destinazione obbligatorio' });
  }

  // Verifica permessi: solo admin o promoter livello 1
  if (req.userRole !== 'admin') {
    const userLevel = await getUserLevel(req.userId);
    if (!(req.userRole === 'promoter' && userLevel === 1)) {
      return res.status(403).json({ success: false, message: 'Solo admin o promoter di livello 1 possono creare kit da carico' });
    }
  }

  // Verifica che il magazzino sia autorizzato
  if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzinoId))) {
    return res.status(403).json({ success: false, message: 'Magazzino non autorizzato' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Raccogli gli articoli selezionati per categoria
    const articoliSelezionati = {};
    let sciId = null, attaccoId = null, skistopperId = null;
    let sciSiglaId = null, attaccoSiglaId = null, skistopperSiglaId = null;
    let quantitaSci = 0, quantitaAttacco = 0, quantitaSkistopper = 0;

    for (const item of oggetti) {
      // Recupera dettaglio articolo per sapere la categoria
      const [art] = await connection.query(
        'SELECT a.articolo_id, a.descrizione, a.lunghezza, c.nome AS categoria_nome FROM articoli a LEFT JOIN categorie c ON a.categoria = c.categoria_id WHERE a.articolo_id = ?',
        [item.oggettoId]
      );
      if (!art.length) throw new Error(`Articolo ${item.oggettoId} non trovato`);
      const categoria = art[0].categoria_nome || '';

      if (categoria.toLowerCase() === 'sci') {
        if (sciId) throw new Error('Puoi selezionare un solo sci per kit');
        sciId = item.oggettoId;
        sciSiglaId = item.siglaId;
        quantitaSci = item.quantita;
        articoliSelezionati[sciId] = { ...item, categoria, articolo: art[0] };
      } else if (categoria.toLowerCase() === 'attacchi') {
        if (attaccoId) throw new Error('Puoi selezionare un solo attacco per kit');
        attaccoId = item.oggettoId;
        attaccoSiglaId = item.siglaId;
        quantitaAttacco = item.quantita;
        articoliSelezionati[attaccoId] = { ...item, categoria, articolo: art[0] };
      } else if (categoria.toLowerCase() === 'skistoppers') {
        if (skistopperId) throw new Error('Puoi selezionare un solo skistopper per kit');
        skistopperId = item.oggettoId;
        skistopperSiglaId = item.siglaId;
        quantitaSkistopper = item.quantita;
        articoliSelezionati[skistopperId] = { ...item, categoria, articolo: art[0] };
      } else {
        throw new Error(`Categoria ${categoria} non valida per composizione kit`);
      }
    }

    if (!sciId) throw new Error('Devi selezionare almeno uno sci');
    if (!attaccoId) throw new Error('Devi selezionare almeno un attacco');

    // Verifica che le quantità siano coerenti (tutte le quantità delle righe devono essere uguali)
    const qta = quantitaSci;
    if (quantitaAttacco !== qta) throw new Error('La quantità dello sci e dell\'attacco deve essere la stessa');
    if (skistopperId && quantitaSkistopper !== qta) throw new Error('La quantità dello skistopper deve essere uguale a quella dello sci');

    // 1. Rimuovi gli articoli selezionati dal carico del soggetto
    for (const id in articoliSelezionati) {
      const item = articoliSelezionati[id];
      await aggiornaCaricoSintesi(
        connection,
        soggettoTipo,
        soggettoId,
        'ARTICOLO',
        item.oggettoId,
        item.siglaId,
        0, // rimuovi
        null,
        null,
        null
      );
    }

    // 2. Crea il kit
    const [maxIdRow] = await connection.query('SELECT MAX(id) AS maxId FROM kit');
    const nextSeq = (maxIdRow[0].maxId || 0) + 1;
    const codiceKit = `KIT-${magazzinoId}-${String(nextSeq).padStart(4, '0')}`;

    // Recupera descrizione sci per generare descrizione kit
    const [sci] = await connection.query('SELECT descrizione, lunghezza FROM articoli WHERE articolo_id = ?', [sciId]);
    const righe = [{ attacco_id: attaccoId }]; // generiamo descrizione con un solo attacco
    const descKit = await generaDescrizioneKit(connection, sci[0], righe);

    const now = db.now();
    const [kitRes] = await connection.query(
      'INSERT INTO kit (codice_kit, descrizione, quantita, magazzino, note, data_creazione, data_modifica) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [codiceKit, descKit, qta, magazzinoId, note || null, now, now]
    );
    const kitId = kitRes.insertId;

    // 3. Inserisci dettagli kit
    // SCI
    await connection.query(
      'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SCI\', ?, ?, ?)',
      [kitId, sciId, sciSiglaId, qta]
    );
    // ATTACCHI
    await connection.query(
      'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'ATTACCHI\', ?, NULL, ?)',
      [kitId, attaccoId, qta]
    );
    // SKISTOPPER (se presente)
    if (skistopperId) {
      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SKISTOPPER\', ?, NULL, ?)',
        [kitId, skistopperId, qta]
      );
    }

    // 4. Aggiorna quantita_in_kit per gli articoli componenti
    await aggiungiInKit(connection, sciId, qta);
    await aggiungiInKit(connection, attaccoId, qta);
    if (skistopperId) {
      await aggiungiInKit(connection, skistopperId, qta);
    }

    // 5. Aggiungi il kit al carico del destinatario
    await aggiornaCaricoSintesi(
      connection,
      destinazioneTipo,
      destinazioneId,
      'KIT',
      kitId,
      null,
      qta,
      soggettoTipo,
      soggettoId,
      now
    );

    // 6. Registra movimento
    await connection.query(
      `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
       VALUES (?, 'KIT_DA_CARICO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
      [now, `${soggettoTipo}-${soggettoId}`, `${destinazioneTipo}-${destinazioneId}`, kitId, 'KIT', qta, req.userId, note, null]
    );

    await connection.commit();
    res.json({ success: true, message: 'Kit creato da carico con successo', kitId });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore creazione kit da carico:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// Helper per livello utente (duplicato da assegnazioni per evitare dipendenze circolari)
async function getUserLevel(userId) {
  const [user] = await db.query('SELECT riferimento_id FROM utenti WHERE id = ?', [userId]);
  if (!user.length || !user[0].riferimento_id) return 0;
  const [sog] = await db.query('SELECT livello FROM soggetti WHERE id = ?', [user[0].riferimento_id]);
  return sog.length ? (sog[0].livello || 0) : 0;
}

// ============================================================
// PUT /api/kit/:id - Modifica completa del kit
// ============================================================
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { magazzino, sci_id, note, righe } = req.body;
  if (!magazzino || !sci_id || !righe || !righe.length) {
    return res.status(400).json({ success: false, message: 'Dati incompleti' });
  }

  if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzino))) {
    return res.status(403).json({ success: false, message: 'Magazzino non autorizzato' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [oldDetails] = await connection.query('SELECT * FROM kit_dettaglio WHERE kit_id = ?', [id]);
    for (const det of oldDetails) {
      await rimuoviDaKit(connection, det.articolo_id, det.quantita);
    }
    await connection.query('DELETE FROM kit_dettaglio WHERE kit_id = ?', [id]);

    const [sci] = await connection.query('SELECT descrizione, lunghezza, durezza FROM articoli WHERE articolo_id = ?', [sci_id]);
    if (!sci.length) throw new Error('Sci non trovato');
    const descKit = await generaDescrizioneKit(connection, sci[0], righe);

    let quantitaTotaleKit = 0;
    for (const riga of righe) {
      const { sigla_id, attacco_id, skistopper_id, quantita } = riga;
      await aggiungiInKit(connection, sci_id, quantita);
      await aggiungiInKit(connection, attacco_id, quantita);
      if (skistopper_id) {
        await aggiungiInKit(connection, skistopper_id, quantita);
      }

      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SCI\', ?, ?, ?)',
        [id, sci_id, sigla_id, quantita]
      );
      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'ATTACCHI\', ?, NULL, ?)',
        [id, attacco_id, quantita]
      );
      if (skistopper_id) {
        await connection.query(
          'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SKISTOPPER\', ?, NULL, ?)',
          [id, skistopper_id, quantita]
        );
      }
      quantitaTotaleKit += quantita;
    }

    const now = db.now();
    await connection.query(
      'UPDATE kit SET magazzino = ?, note = ?, quantita = ?, descrizione = ?, data_modifica = ? WHERE id = ?',
      [magazzino, note || null, quantitaTotaleKit, descKit, now, id]
    );
    await connection.commit();
    res.json({ success: true, message: 'Kit aggiornato' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore PUT /kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// PATCH /api/kit/:id/note - Aggiorna solo la nota del kit
// ============================================================
router.patch('/:id/note', verifyToken, async (req, res) => {
  const { note } = req.body;
  if (note === undefined) {
    return res.status(400).json({ error: 'Campo note mancante' });
  }
  const connection = await db.getConnection();
  try {
    await connection.query('UPDATE kit SET note = ?, data_modifica = ? WHERE id = ?', [note, db.now(), req.params.id]);
    connection.release();
    res.json({ success: true, message: 'Nota kit aggiornata' });
  } catch(err) {
    connection.release();
    console.error('❌ Errore PATCH /kit/:id/note:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// DELETE /api/kit/:id - Elimina kit
// ============================================================
router.delete('/:id', verifyToken, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [dettagli] = await connection.query('SELECT * FROM kit_dettaglio WHERE kit_id = ?', [req.params.id]);
    for (const det of dettagli) {
      await rimuoviDaKit(connection, det.articolo_id, det.quantita);
    }
    await connection.query('DELETE FROM kit_dettaglio WHERE kit_id = ?', [req.params.id]);
    await connection.query('DELETE FROM kit WHERE id = ?', [req.params.id]);

    await connection.commit();
    res.json({ success: true, message: 'Kit eliminato con successo' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore DELETE /kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;