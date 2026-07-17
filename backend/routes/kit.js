const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');
const { canUserUseMagazzino } = require('./articoli');

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
    console.log('📋 GET /api/kit');
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
// GET /api/kit/sigle-usate - Sigle già utilizzate in kit (ROTTA FONDAMENTALE)
// Deve essere PRIMA di /:id per evitare conflitto
// ============================================================
router.get('/sigle-usate', verifyToken, async (req, res) => {
  try {
    console.log('🔍 GET /api/kit/sigle-usate');
    const [rows] = await db.query(`
      SELECT DISTINCT kd.sigla_id AS id, s.sigla
      FROM kit_dettaglio kd
      INNER JOIN sigle_articoli s ON kd.sigla_id = s.id
      WHERE s.attivo = 1
      ORDER BY s.sigla
    `);
    console.log(`✅ Trovate ${rows.length} sigle usate`);
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
    console.log(`📋 GET /api/kit/${req.params.id}`);
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
// HELPER: confronta due kit per uguaglianza delle righe
// ============================================================
async function findMatchingKit(connection, magazzino, sciId, newRighe) {
  // Cerca tutti i kit con lo stesso magazzino e sci_id (dobbiamo trovare il kit che ha le stesse righe)
  // Prima prendiamo tutti i kit che hanno lo stesso sci e magazzino
  const [kits] = await connection.query(`
    SELECT k.id
    FROM kit k
    WHERE k.magazzino = ? AND EXISTS (
      SELECT 1 FROM kit_dettaglio kd WHERE kd.kit_id = k.id AND kd.articolo_id = ? AND kd.tipo_articolo = 'SCI'
    )
  `, [magazzino, sciId]);

  // Per ogni kit, prendiamo le sue righe e le confrontiamo con le nuove righe
  // Le righe devono essere identiche in numero e valori (sigla_id, attacco_id, skistopper_id)
  // Ignoriamo quantita perché verrà sommata.
  for (const kitRow of kits) {
    const [dettagli] = await connection.query(`
      SELECT sigla_id, articolo_id as attacco_id, skistopper_id
      FROM kit_dettaglio
      WHERE kit_id = ?
      ORDER BY sigla_id, attacco_id, skistopper_id
    `, [kitRow.id]);
    // Normalizza le nuove righe
    const newNormalized = newRighe.map(r => ({
      sigla_id: r.sigla_id,
      attacco_id: r.attacco_id,
      skistopper_id: r.skistopper_id
    })).sort((a, b) => {
      if (a.sigla_id !== b.sigla_id) return a.sigla_id - b.sigla_id;
      if (a.attacco_id !== b.attacco_id) return a.attacco_id - b.attacco_id;
      return (a.skistopper_id || 0) - (b.skistopper_id || 0);
    });
    const existingNormalized = dettagli.map(d => ({
      sigla_id: d.sigla_id,
      attacco_id: d.attacco_id,
      skistopper_id: d.skistopper_id
    })).sort((a, b) => {
      if (a.sigla_id !== b.sigla_id) return a.sigla_id - b.sigla_id;
      if (a.attacco_id !== b.attacco_id) return a.attacco_id - b.attacco_id;
      return (a.skistopper_id || 0) - (b.skistopper_id || 0);
    });
    // Confronta le due liste di oggetti
    if (newNormalized.length === existingNormalized.length &&
        newNormalized.every((obj, idx) => 
          obj.sigla_id === existingNormalized[idx].sigla_id &&
          obj.attacco_id === existingNormalized[idx].attacco_id &&
          obj.skistopper_id === existingNormalized[idx].skistopper_id
        )) {
      return kitRow.id;
    }
  }
  return null;
}

// ============================================================
// POST /api/kit - Crea un nuovo kit o aggiorna quantità se esiste
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  console.log('📝 POST /api/kit');
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

    // Verifica se esiste già un kit identico
    const existingKitId = await findMatchingKit(connection, magazzino, sci_id, righe);

    if (existingKitId) {
      // Aggiorna il kit esistente: incrementa la quantità di ogni riga
      console.log(`♻️ Trovato kit esistente ID ${existingKitId}, incremento quantità`);
      
      // Per ogni riga, incrementa la quantità nel kit_dettaglio
      for (const riga of righe) {
        const { sigla_id, attacco_id, skistopper_id, quantita } = riga;
        await connection.query(
          `UPDATE kit_dettaglio 
           SET quantita = quantita + ? 
           WHERE kit_id = ? AND sigla_id = ? AND articolo_id = ? AND (skistopper_id <=> ?)`,
          [quantita, existingKitId, sigla_id, attacco_id, skistopper_id]
        );
        // Incrementa anche la quantita_in_kit degli articoli coinvolti
        await aggiungiInKit(connection, sci_id, quantita);
        await aggiungiInKit(connection, attacco_id, quantita);
        if (skistopper_id) await aggiungiInKit(connection, skistopper_id, quantita);
      }

      // Ricalcola la quantità totale del kit
      const [sum] = await connection.query(
        'SELECT SUM(quantita) AS totale FROM kit_dettaglio WHERE kit_id = ?',
        [existingKitId]
      );
      const nuovaQuantita = sum[0].totale || 0;
      await connection.query(
        'UPDATE kit SET quantita = ?, data_modifica = NOW() WHERE id = ?',
        [nuovaQuantita, existingKitId]
      );

      await connection.commit();
      console.log(`✅ Kit ${existingKitId} aggiornato con nuova quantità ${nuovaQuantita}`);
      return res.json({ success: true, message: 'Kit aggiornato con successo', kitId: existingKitId });
    }

    // Se non esiste, crea un nuovo kit (codice esistente)
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
      if (skistopper_id) await aggiungiInKit(connection, skistopper_id, quantita);

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
    console.log(`✅ Kit creato con ID ${kitId}`);
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
// PUT /api/kit/:id - Modifica completa del kit
// ============================================================
router.put('/:id', verifyToken, async (req, res) => {
  console.log(`📝 PUT /api/kit/${req.params.id}`);
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
      if (skistopper_id) await aggiungiInKit(connection, skistopper_id, quantita);

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
    console.log(`✅ Kit ${id} aggiornato`);
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
  console.log(`📝 PATCH /api/kit/${req.params.id}/note`);
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
  console.log(`🗑️ DELETE /api/kit/${req.params.id}`);
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
    console.log(`✅ Kit ${req.params.id} eliminato`);
    res.json({ success: true, message: 'Kit eliminato con successo' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore DELETE /kit:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

console.log('✅ ROTTE KIT REGISTRATE:');
console.log('   GET    /api/kit');
console.log('   GET    /api/kit/sigle-usate  <-- FONDAMENTALE');
console.log('   GET    /api/kit/:id');
console.log('   POST   /api/kit (con upsert per kit duplicati)');
console.log('   PUT    /api/kit/:id');
console.log('   PATCH  /api/kit/:id/note');
console.log('   DELETE /api/kit/:id');

module.exports = router;