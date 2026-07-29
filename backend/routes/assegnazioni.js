const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');
const db = require('../db');
const { ricalcolaQuantitaTotale } = require('./articoli');

const router = express.Router();

// Helper: verifica se l'utente può usare un magazzino
async function canUserUseMagazzino(userId, userRole, magazzinoId) {
  if (userRole === 'admin') return true;
  const [user] = await pool.query('SELECT riferimento_id FROM utenti WHERE id = ?', [userId]);
  if (!user.length || !user[0].riferimento_id) return false;
  const soggettoId = user[0].riferimento_id;
  const [rows] = await pool.query(
    'SELECT 1 FROM soggetti_magazzini WHERE soggetto_id = ? AND magazzino_id = ?',
    [soggettoId, magazzinoId]
  );
  return rows.length > 0;
}

// Helper: ottiene il livello del soggetto di un utente
async function getUserLevel(userId) {
  const [user] = await pool.query('SELECT riferimento_id FROM utenti WHERE id = ?', [userId]);
  if (!user.length || !user[0].riferimento_id) return 0;
  const [sog] = await pool.query('SELECT livello FROM soggetti WHERE id = ?', [user[0].riferimento_id]);
  return sog.length ? (sog[0].livello || 0) : 0;
}

// ============================================================
// HELPER: Calcola la disponibilità reale di una sigla
// ============================================================
async function getDisponibilitaSigla(connection, siglaId, articoloId) {
  const [sigla] = await connection.query(
    'SELECT quantita FROM sigle_articoli WHERE id = ? AND articolo_id = ? AND attivo = 1',
    [siglaId, articoloId]
  );
  if (!sigla.length) return 0;
  const quantitaSigla = sigla[0].quantita;

  const [inKit] = await connection.query(
    'SELECT COALESCE(SUM(quantita), 0) AS totale FROM kit_dettaglio WHERE sigla_id = ?',
    [siglaId]
  );

  const [assegnata] = await connection.query(
    'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE sigla_id = ? AND tipo_oggetto = \'ARTICOLO\'',
    [siglaId]
  );

  const disponibile = quantitaSigla - inKit[0].totale - assegnata[0].totale;
  return Math.max(0, disponibile);
}

// ============================================================
// ENDPOINT: disponibilità sigla
// ============================================================
router.get('/disponibilita-sigla', verifyToken, async (req, res) => {
  const { sigla_id, articolo_id } = req.query;
  if (!sigla_id || !articolo_id) {
    return res.status(400).json({ error: 'Parametri mancanti: sigla_id e articolo_id obbligatori' });
  }
  const connection = await pool.getConnection();
  try {
    const disponibile = await getDisponibilitaSigla(connection, parseInt(sigla_id), parseInt(articolo_id));
    res.json({ disponibile });
  } catch (err) {
    console.error('Errore /disponibilita-sigla:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// ENDPOINT: quantità assegnata per kit (esclude MAGAZZINO)
// ============================================================
router.get('/quantita-assegnata-kit', verifyToken, async (req, res) => {
  const { kit_id } = req.query;
  if (!kit_id) return res.status(400).json({ error: 'kit_id richiesto' });
  const [rows] = await pool.query(
    `SELECT COALESCE(SUM(quantita), 0) AS quantita 
     FROM carico_sintesi 
     WHERE tipo_oggetto = 'KIT' AND oggetto_id = ? AND destinazione_tipo != 'MAGAZZINO'`,
    [kit_id]
  );
  res.json({ quantita: rows[0].quantita });
});

// ============================================================
// HELPER: Verifica se un promoter può assegnare a un soggetto
// ============================================================
async function canPromoterAssignTo(connection, promoterId, targetSoggettoId) {
  const [p] = await connection.query('SELECT livello FROM soggetti WHERE id = ?', [promoterId]);
  if (!p.length) return false;
  const livelloPromoter = p[0].livello || 0;
  if (livelloPromoter === 0) return false;
  const [t] = await connection.query('SELECT tipo, livello FROM soggetti WHERE id = ?', [targetSoggettoId]);
  if (!t.length) return false;
  const tipoTarget = t[0].tipo;
  const livelloTarget = t[0].livello || 0;
  if (tipoTarget !== 'PROMOTER') return true;
  if (livelloPromoter === 1) return true;
  if (livelloPromoter === 2) return livelloTarget === 3;
  if (livelloPromoter === 3) return false;
  return false;
}

// ============================================================
// HELPER: Aggiorna carico_sintesi (con SOMMA invece di sostituzione)
// ============================================================
async function aggiornaCaricoSintesi(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, quantita, provenienzaTipo, provenienzaId, dataAssegnazione) {
  
  // 🔥 NON inserire righe con destinazione MAGAZZINO
  if (destinazioneTipo === 'MAGAZZINO') {
    console.log('⚠️ Tentativo di inserire carico_sintesi con destinazione MAGAZZINO - ignorato');
    return;
  }

  if (quantita === 0) {
    // ELIMINA la riga
    const deleteParams = [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, siglaId];
    const sql = `
      DELETE FROM carico_sintesi 
      WHERE destinazione_tipo = ? AND destinazione_id = ? 
        AND tipo_oggetto = ? AND oggetto_id = ? 
        AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))
    `;
    console.log('🗑️ DELETE da carico_sintesi:', sql, deleteParams);
    const [result] = await connection.query(sql, deleteParams);
    if (result.affectedRows === 0) {
      console.warn('⚠️ Nessuna riga eliminata in carico_sintesi per:', { destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId });
    } else {
      console.log('✅ Riga eliminata da carico_sintesi');
    }
    return;
  }

  // 🔥 Verifica se esiste già una riga per questa combinazione
  const [existing] = await connection.query(
    `SELECT quantita FROM carico_sintesi 
     WHERE destinazione_tipo = ? AND destinazione_id = ? 
       AND tipo_oggetto = ? AND oggetto_id = ? 
       AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))`,
    [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, siglaId]
  );

  if (existing.length > 0) {
    // 🔥 Aggiorna SOMMANDO la quantità
    await connection.query(
      `UPDATE carico_sintesi 
       SET quantita = quantita + ?, 
           provenienza_tipo = ?, 
           provenienza_id = ?, 
           data_assegnazione = ?
       WHERE destinazione_tipo = ? AND destinazione_id = ? 
         AND tipo_oggetto = ? AND oggetto_id = ? 
         AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))`,
      [quantita, provenienzaTipo, provenienzaId, dataAssegnazione || db.now(),
       destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, siglaId]
    );
    console.log(`✅ Aggiornata quantità per ${tipoOggetto} ${oggettoId} a ${destinazioneTipo} ${destinazioneId}: +${quantita}`);
  } else {
    // 🔥 Inserisci nuova riga
    await connection.query(
      `INSERT INTO carico_sintesi 
       (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, sigla_id, quantita, provenienza_tipo, provenienza_id, data_assegnazione)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId || null, quantita, provenienzaTipo, provenienzaId, dataAssegnazione || db.now()]
    );
    console.log(`✅ Inserita nuova riga per ${tipoOggetto} ${oggettoId} a ${destinazioneTipo} ${destinazioneId}: ${quantita}`);
  }
}

// ============================================================
// USCITA BATCH (dal magazzino)
// ============================================================
router.post('/uscita/batch', verifyToken, async (req, res) => {
  const { magazzinoId, destinazioneTipo, destinazioneId, note, oggetti } = req.body;
  if (!destinazioneTipo || !destinazioneId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const userLevel = await getUserLevel(req.userId);
    if (req.userRole !== 'admin' && !(req.userRole === 'promoter' && userLevel === 1)) {
      throw new Error('Solo admin o promoter di livello 1 possono prelevare dal magazzino');
    }

    if (!(await canUserUseMagazzino(req.userId, req.userRole, magazzinoId))) {
      throw new Error('Magazzino non autorizzato per questo utente');
    }

    let provenienzaTipo = 'MAGAZZINO';
    let provenienzaId = magazzinoId;
    const [user] = await connection.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
    if (user[0] && user[0].riferimento_id && req.userRole !== 'admin') {
      provenienzaTipo = 'PROMOTER';
      provenienzaId = user[0].riferimento_id;
    }

    const [userInfo] = await connection.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
    const operatore = userInfo[0].username;
    const now = db.now();

    for (const item of oggetti) {
      const { tipoOggetto, oggettoId, siglaId, quantita } = item;

      if (tipoOggetto === 'ARTICOLO') {
        let siglaDaUsare = siglaId;
        if (!siglaDaUsare) {
          const [sigle] = await connection.query(
            'SELECT id FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 ORDER BY quantita DESC',
            [oggettoId]
          );
          for (const s of sigle) {
            const disp = await getDisponibilitaSigla(connection, s.id, oggettoId);
            if (disp >= quantita) { siglaDaUsare = s.id; break; }
          }
          if (!siglaDaUsare) throw new Error('Nessuna sigla con quantità sufficiente');
        } else {
          const disp = await getDisponibilitaSigla(connection, siglaDaUsare, oggettoId);
          if (disp < quantita) throw new Error('Quantità insufficiente per la sigla');
        }
        await aggiornaCaricoSintesi(connection, destinazioneTipo, destinazioneId, 'ARTICOLO', oggettoId, siglaDaUsare, quantita, provenienzaTipo, provenienzaId, now);
      } else if (tipoOggetto === 'KIT') {
        const [kit] = await connection.query('SELECT quantita FROM kit WHERE id = ? FOR UPDATE', [oggettoId]);
        if (!kit.length || kit[0].quantita < quantita) {
          throw new Error(`Quantità kit ${oggettoId} insufficiente (disponibile ${kit[0]?.quantita || 0})`);
        }
        const [assegnato] = await connection.query(
          'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE tipo_oggetto = \'KIT\' AND oggetto_id = ?',
          [oggettoId]
        );
        const disponibileKit = kit[0].quantita - assegnato[0].totale;
        if (disponibileKit < quantita) {
          throw new Error(`Quantità kit ${oggettoId} già assegnata parzialmente (disponibile ${disponibileKit})`);
        }
        await aggiornaCaricoSintesi(connection, destinazioneTipo, destinazioneId, 'KIT', oggettoId, null, quantita, provenienzaTipo, provenienzaId, now);
      }

      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
         VALUES (?, 'USCITA', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [now, `MAGAZZINO-${magazzinoId}`, `${destinazioneTipo}-${destinazioneId}`, oggettoId, tipoOggetto, quantita, operatore, note, siglaId || null]
      );
    }

    await connection.commit();
    res.json({ success: true, message: `Assegnati ${oggetti.length} oggetti` });
  } catch (err) {
    await connection.rollback();
    console.error('Errore /uscita/batch:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// RIENTRO BATCH
// ============================================================
router.post('/rientro/batch', verifyToken, async (req, res) => {
  const { magazzinoId, note, oggetti } = req.body;
  if (!magazzinoId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    if (req.userRole !== 'admin') {
      const userLevel = await getUserLevel(req.userId);
      if (!(req.userRole === 'promoter' && userLevel === 1)) {
        return res.status(403).json({ success: false, message: 'Solo admin o promoter di livello 1 possono effettuare rientri' });
      }
    }

    const [user] = await connection.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
    const operatore = user[0].username;
    const now = db.now();

    for (const item of oggetti) {
      const { tipoOggetto, oggettoId, siglaId, quantita, daTipo, daId } = item;
      const provenienzaTipo = daTipo || 'PROMOTER';
      const provenienzaId = daId || null;

      console.log(`🔄 Rientro: tipo=${tipoOggetto}, id=${oggettoId}, siglaId=${siglaId}, quantita=${quantita}, daTipo=${provenienzaTipo}, daId=${provenienzaId}`);

      if (tipoOggetto === 'ARTICOLO') {
        await aggiornaCaricoSintesi(connection, provenienzaTipo, provenienzaId, 'ARTICOLO', oggettoId, siglaId, 0, null, null, null);
      } else if (tipoOggetto === 'KIT') {
        await aggiornaCaricoSintesi(connection, provenienzaTipo, provenienzaId, 'KIT', oggettoId, null, 0, null, null, null);
      }

      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
         VALUES (?, 'RIENTRO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [now, `${provenienzaTipo}-${provenienzaId}`, `MAGAZZINO-${magazzinoId}`, oggettoId, tipoOggetto, quantita, operatore, note, siglaId || null]
      );
    }

    await connection.commit();
    res.json({ success: true, message: `Rientrati ${oggetti.length} oggetti` });
  } catch (err) {
    await connection.rollback();
    console.error('Errore /rientro/batch:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// TRASFERIMENTO (da un soggetto a un altro)
// ============================================================
router.post('/trasferimento', verifyToken, async (req, res) => {
  const { daTipo, daId, aTipo, aId, magazzinoId, oggetti, note } = req.body;
  if (!daTipo || !daId || !aTipo || !aId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    if (req.userRole !== 'admin') {
      const [user] = await connection.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
      const promoterId = user[0]?.riferimento_id;
      if (promoterId) {
        const canAssign = await canPromoterAssignTo(connection, promoterId, aId);
        if (!canAssign) {
          throw new Error('Non hai i permessi per trasferire a questo soggetto (livello insufficiente)');
        }
      }
    }

    const [user] = await connection.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
    const operatore = user[0].username;
    const now = db.now();

    for (const item of oggetti) {
      const { tipoOggetto, oggettoId, siglaId, quantita } = item;
      const itemDaTipo = item.daTipo || daTipo;
      const itemDaId = item.daId || daId;

      // Rimuovi dal vecchio destinatario
      if (tipoOggetto === 'ARTICOLO') {
        await aggiornaCaricoSintesi(connection, itemDaTipo, itemDaId, 'ARTICOLO', oggettoId, siglaId, 0, null, null, null);
      } else if (tipoOggetto === 'KIT') {
        await aggiornaCaricoSintesi(connection, itemDaTipo, itemDaId, 'KIT', oggettoId, null, 0, null, null, null);
      }

      // Aggiungi al nuovo destinatario
      if (tipoOggetto === 'ARTICOLO') {
        let siglaDaUsare = siglaId;
        if (!siglaDaUsare) {
          const [sigle] = await connection.query(
            'SELECT id FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 ORDER BY quantita DESC',
            [oggettoId]
          );
          for (const s of sigle) {
            const disp = await getDisponibilitaSigla(connection, s.id, oggettoId);
            if (disp >= quantita) { siglaDaUsare = s.id; break; }
          }
          if (!siglaDaUsare) throw new Error('Nessuna sigla con quantità sufficiente');
        } else {
          const disp = await getDisponibilitaSigla(connection, siglaDaUsare, oggettoId);
          if (disp < quantita) throw new Error('Quantità insufficiente per la sigla');
        }
        await aggiornaCaricoSintesi(connection, aTipo, aId, 'ARTICOLO', oggettoId, siglaDaUsare, quantita, itemDaTipo, itemDaId, now);
      } else if (tipoOggetto === 'KIT') {
        await aggiornaCaricoSintesi(connection, aTipo, aId, 'KIT', oggettoId, null, quantita, itemDaTipo, itemDaId, now);
      }

      await connection.query(
        `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
         VALUES (?, 'TRASFERIMENTO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [now, `${itemDaTipo}-${itemDaId}`, `${aTipo}-${aId}`, oggettoId, tipoOggetto, quantita, operatore, note, siglaId || null]
      );
    }

    await connection.commit();
    res.json({ success: true, message: `Trasferiti ${oggetti.length} oggetti` });
  } catch (err) {
    await connection.rollback();
    console.error('Errore /trasferimento:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// DIVIDI E TRASFERISCI (quantità parziale)
// ============================================================
router.post('/dividi', verifyToken, async (req, res) => {
  console.log('📋 [POST] /dividi - body:', req.body);
  const { 
    daTipo, daId, aTipo, aId, 
    tipoOggetto, oggettoId, siglaId, 
    quantitaDaTrasferire, quantitaRimanente, note 
  } = req.body;

  if (!daTipo || !daId || !aTipo || !aId || !tipoOggetto || !oggettoId) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }
  if (quantitaDaTrasferire <= 0 || quantitaRimanente <= 0) {
    return res.status(400).json({ success: false, message: 'Le quantità devono essere positive' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [userRows] = await connection.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
    const operatore = userRows.length ? userRows[0].username : 'sconosciuto';
    const now = db.now();

    // 1. Aggiorna la riga originale (riduci la quantità)
    let sqlUpdate = `
      UPDATE carico_sintesi 
      SET quantita = ? 
      WHERE destinazione_tipo = ? AND destinazione_id = ? 
        AND tipo_oggetto = ? AND oggetto_id = ? 
    `;
    const paramsUpdate = [quantitaRimanente, daTipo, daId, tipoOggetto, oggettoId];
    
    if (siglaId) {
      sqlUpdate += ' AND sigla_id = ?';
      paramsUpdate.push(siglaId);
    } else {
      sqlUpdate += ' AND sigla_id IS NULL';
    }
    
    const [updateResult] = await connection.query(sqlUpdate, paramsUpdate);

    if (updateResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Nessuna riga trovata da aggiornare.' });
    }

    // 2. Crea la nuova riga per il destinatario (se non è MAGAZZINO)
    if (aTipo !== 'MAGAZZINO') {
      await connection.query(
        `INSERT INTO carico_sintesi 
         (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, sigla_id, quantita, provenienza_tipo, provenienza_id, data_assegnazione)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           quantita = quantita + VALUES(quantita),
           provenienza_tipo = VALUES(provenienza_tipo),
           provenienza_id = VALUES(provenienza_id),
           data_assegnazione = VALUES(data_assegnazione)`,
        [aTipo, aId, tipoOggetto, oggettoId, siglaId || null, quantitaDaTrasferire, daTipo, daId, now]
      );
    } else {
      console.log('⚠️ Destinazione MAGAZZINO - non creo riga in carico_sintesi');
    }

    // 3. Registra movimento
    const notaCompleta = note 
      ? `${note} - Divisione parziale (rimanente: ${quantitaRimanente}, trasferito: ${quantitaDaTrasferire})`
      : `Divisione parziale (rimanente: ${quantitaRimanente}, trasferito: ${quantitaDaTrasferire})`;
      
    await connection.query(
      `INSERT INTO movimenti 
       (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
       VALUES (?, 'TRASFERIMENTO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
      [now, `${daTipo}-${daId}`, `${aTipo}-${aId}`, oggettoId, tipoOggetto, quantitaDaTrasferire, operatore, notaCompleta, siglaId || null]
    );

    await connection.commit();
    res.json({ success: true, message: 'Divisione e trasferimento completati' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ [POST] /dividi - errore:', err);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  } finally {
    connection.release();
  }
});

// ============================================================
// OTTIENI OGGETTI IN CARICO
// ============================================================
// ============================================================
// POST /api/assegnazioni/oggetti - con filtro settore
// ============================================================
router.post('/oggetti', verifyToken, async (req, res) => {
  try {
    const { targetTipo, targetId, magazzino, includeReferenced, settore } = req.body;
    if (!targetTipo || !targetId) {
      return res.status(400).json({ success: false, message: 'Parametri mancanti' });
    }

    const connection = await pool.getConnection();

    const getOggettiPerSoggetto = async (tipo, id) => {
      let sql = `
        SELECT cs.*,
          CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione ELSE k.descrizione END AS descrizione,
          CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice ELSE k.codice_kit END AS codice,
          a.lunghezza AS LUNGHEZZA,
          a.durezza AS DUREZZA,
          COALESCE(s.sigla, 
            (SELECT s2.sigla FROM kit_dettaglio kd 
             LEFT JOIN sigle_articoli s2 ON kd.sigla_id = s2.id 
             WHERE kd.kit_id = cs.oggetto_id AND kd.tipo_articolo = 'SCI' LIMIT 1)
          ) AS SIGLA_CORRENTE,
          sog.nome AS destinatario_nome,
          sog.cognome AS destinatario_cognome,
          c.nome AS categoria_nome
        FROM carico_sintesi cs
        LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
        LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
        LEFT JOIN sigle_articoli s ON cs.sigla_id = s.id
        LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
        LEFT JOIN categorie c ON a.categoria = c.categoria_id
        WHERE cs.destinazione_tipo = ? AND cs.destinazione_id = ? AND cs.quantita > 0
      `;
      const params = [tipo, id];

      // 🔥 Filtro settore
      if (settore) {
        sql += ' AND (a.settore = ? OR k.settore = ?)';
        params.push(settore, settore);
      }

      if (magazzino) {
        sql += ' AND (a.magazzino = ? OR k.magazzino = ?)';
        params.push(magazzino, magazzino);
      }

      const [rows] = await connection.query(sql, params);
      const risultati = [];
      // ... resto del codice invariato ...
    };
    // ... resto della funzione ...
  } catch (err) {
    console.error('Errore /oggetti:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

      for (const row of rows) {
        let sigleDisponibili = [];
        if (row.tipo_oggetto === 'ARTICOLO') {
          const [sigle] = await connection.query(
            'SELECT id, sigla, durezza, lunghezza, quantita FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 AND quantita > 0',
            [row.oggetto_id]
          );
          sigleDisponibili = sigle;
        } else if (row.tipo_oggetto === 'KIT') {
          const [sci] = await connection.query(
            'SELECT articolo_id FROM kit_dettaglio WHERE kit_id = ? AND tipo_articolo = \'SCI\' LIMIT 1',
            [row.oggetto_id]
          );
          if (sci.length) {
            const [sigle] = await connection.query(
              'SELECT id, sigla, durezza, lunghezza, quantita FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 AND quantita > 0',
              [sci[0].articolo_id]
            );
            sigleDisponibili = sigle;
          }
        }

        const destinatarioNome = row.destinazione_tipo === 'PROMOTER'
          ? ((row.destinatario_nome || '') + ' ' + (row.destinatario_cognome || '')).trim()
          : (row.destinatario_nome || '');

        risultati.push({
          tipo: row.tipo_oggetto,
          ID: row.oggetto_id,
          siglaId: row.sigla_id,
          descrizione: row.descrizione || '',
          codice: row.codice || '',
          quantita: row.quantita,
          LUNGHEZZA: row.LUNGHEZZA || '',
          DUREZZA: row.DUREZZA || '',
          SIGLA_CORRENTE: row.SIGLA_CORRENTE || '',
          destinazioneTipo: row.destinazione_tipo,
          destinazioneId: row.destinazione_id,
          destinatarioNome: destinatarioNome,
          sigleDisponibili: sigleDisponibili,
          provenienzaTipo: row.provenienza_tipo,
          provenienzaId: row.provenienza_id,
          dataAssegnazione: row.data_assegnazione,
          categoriaNome: row.categoria_nome || null
        });
      }
      return risultati;
    };

    let oggetti = await getOggettiPerSoggetto(targetTipo, targetId);

    if (includeReferenced && targetTipo === 'PROMOTER') {
      const [refs] = await connection.query(
        'SELECT referente_id FROM soggetti_referenti WHERE soggetto_id = ?',
        [targetId]
      );
      for (const ref of refs) {
        const refOggetti = await getOggettiPerSoggetto('PROMOTER', ref.referente_id);
        oggetti = oggetti.concat(refOggetti);
      }
    }

    connection.release();
    res.json({ success: true, oggetti });
  } catch (err) {
    console.error('Errore /oggetti:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// OTTIENI OGGETTI INVIATI (escludendo quelli non trasferiti)
// ============================================================
router.get('/inviati', verifyToken, async (req, res) => {
  try {
    const { provenienza_tipo, provenienza_id } = req.query;
    if (!provenienza_tipo || !provenienza_id) {
      return res.status(400).json({ error: 'provenienza_tipo e provenienza_id richiesti' });
    }

    const [rows] = await pool.query(`
      SELECT cs.*,
        CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione ELSE k.descrizione END AS descrizione,
        CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice ELSE k.codice_kit END AS codice,
        a.lunghezza,
        COALESCE(s.sigla, 
          (SELECT s2.sigla FROM kit_dettaglio kd 
           LEFT JOIN sigle_articoli s2 ON kd.sigla_id = s2.id 
           WHERE kd.kit_id = cs.oggetto_id AND kd.tipo_articolo = 'SCI' LIMIT 1)
        ) AS sigla,
        sog.nome AS destinatario_nome,
        sog.cognome AS destinatario_cognome
      FROM carico_sintesi cs
      LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
      LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
      LEFT JOIN sigle_articoli s ON cs.sigla_id = s.id
      LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
      WHERE cs.provenienza_tipo = ? AND cs.provenienza_id = ? 
        AND cs.quantita > 0
        AND NOT (cs.destinazione_tipo = cs.provenienza_tipo AND cs.destinazione_id = cs.provenienza_id)
    `, [provenienza_tipo, provenienza_id]);

    const result = rows.map(row => ({
      ...row,
      destinatarioNome: row.destinazione_tipo === 'PROMOTER'
        ? ((row.destinatario_nome || '') + ' ' + (row.destinatario_cognome || '')).trim()
        : (row.destinatario_nome || 'Magazzino')
    }));

    res.json(result);
  } catch (err) {
    console.error('Errore /inviati:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// VERIFICA SIGLA ASSEGNATA
// ============================================================
router.get('/verifica-sigla', verifyToken, async (req, res) => {
  try {
    const { tipo_oggetto, oggetto_id, sigla_id, escludi_tipo, escludi_id } = req.query;
    if (!tipo_oggetto || !oggetto_id || !sigla_id) {
      return res.status(400).json({ success: false, message: 'Parametri mancanti' });
    }

    let sql = `
      SELECT cs.destinazione_tipo, cs.destinazione_id, s.nome, s.cognome
      FROM carico_sintesi cs
      LEFT JOIN soggetti s ON s.tipo = cs.destinazione_tipo AND s.id = cs.destinazione_id
      WHERE cs.tipo_oggetto = ? AND cs.oggetto_id = ? AND cs.sigla_id = ? AND cs.quantita > 0
    `;
    const params = [tipo_oggetto, oggetto_id, sigla_id];
    if (escludi_tipo && escludi_id) {
      sql += ' AND NOT (cs.destinazione_tipo = ? AND cs.destinazione_id = ?)';
      params.push(escludi_tipo, escludi_id);
    }

    const [rows] = await pool.query(sql, params);
    if (rows.length === 0) {
      return res.json({ success: true, assegnato_a: null });
    }

    const row = rows[0];
    const nome = row.destinazione_tipo === 'PROMOTER'
      ? ((row.nome || '') + ' ' + (row.cognome || '')).trim()
      : (row.nome || '');

    res.json({
      success: true,
      assegnato_a: { tipo: row.destinazione_tipo, id: row.destinazione_id, nome }
    });
  } catch (err) {
    console.error('Errore /verifica-sigla:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// NUOVA ROTTA: GET /oggetti/tutti
// ============================================================
router.get('/oggetti/tutti', verifyToken, async (req, res) => {
  try {
    // 1. Ottieni i soggetti visibili per l'utente
    let soggettiVisibili = [];
    if (req.userRole === 'admin') {
      const [rows] = await pool.query('SELECT id, tipo FROM soggetti WHERE attivo = 1');
      soggettiVisibili = rows;
    } else {
      const [userRows] = await pool.query('SELECT riferimento_id, ruolo FROM utenti WHERE id = ?', [req.userId]);
      if (userRows.length === 0) return res.status(404).json({ success: false, message: 'Utente non trovato' });
      const user = userRows[0];
      let livello = null, mioId = null;
      if (user.riferimento_id) {
        const [sog] = await pool.query('SELECT id, livello FROM soggetti WHERE id = ?', [user.riferimento_id]);
        if (sog.length) { mioId = sog[0].id; livello = sog[0].livello; }
      }
      let query = 'SELECT s.id, s.tipo FROM soggetti s WHERE 1=1';
      const params = [];
      if (user.ruolo === 'promoter') {
        query += ' AND (s.id = ? OR EXISTS (SELECT 1 FROM soggetti_referenti WHERE referente_id = ? AND soggetto_id = s.id)';
        params.push(mioId, mioId);
        if (livello !== null && livello > 1) { query += ' OR s.livello > ?'; params.push(livello); }
        else if (livello === 1) { query += ' OR s.livello IN (2,3)'; }
        query += ' )';
      } else {
        query += ' AND s.id = ?';
        params.push(mioId);
      }
      query += ' AND s.attivo = 1';
      const [rows] = await pool.query(query, params);
      soggettiVisibili = rows;
    }

    if (soggettiVisibili.length === 0) {
      return res.json({ success: true, oggetti: [] });
    }

    // 2. Costruisci la query per ottenere tutti gli oggetti in carico
    const placeholders = soggettiVisibili.map(() => '(?, ?)').join(', ');
    const paramsQuery = [];
    soggettiVisibili.forEach(s => {
      paramsQuery.push(s.tipo, s.id);
    });

    const sql = `
      SELECT cs.*,
        CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.descrizione ELSE k.descrizione END AS descrizione,
        CASE WHEN cs.tipo_oggetto = 'ARTICOLO' THEN a.codice ELSE k.codice_kit END AS codice,
        a.lunghezza AS LUNGHEZZA,
        a.durezza AS DUREZZA,
        COALESCE(s.sigla, 
          (SELECT s2.sigla FROM kit_dettaglio kd 
           LEFT JOIN sigle_articoli s2 ON kd.sigla_id = s2.id 
           WHERE kd.kit_id = cs.oggetto_id AND kd.tipo_articolo = 'SCI' LIMIT 1)
        ) AS SIGLA_CORRENTE,
        sog.nome AS destinatario_nome,
        sog.cognome AS destinatario_cognome,
        c.nome AS categoria_nome
      FROM carico_sintesi cs
      LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
      LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
      LEFT JOIN sigle_articoli s ON cs.sigla_id = s.id
      LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
      LEFT JOIN categorie c ON a.categoria = c.categoria_id
      WHERE (cs.destinazione_tipo, cs.destinazione_id) IN (${placeholders})
        AND cs.quantita > 0
    `;
    const [rows] = await pool.query(sql, paramsQuery);

    // 3. Formatta i risultati
    const risultati = [];
    for (const row of rows) {
      let sigleDisponibili = [];
      if (row.tipo_oggetto === 'ARTICOLO') {
        const [sigle] = await pool.query(
          'SELECT id, sigla, durezza, lunghezza, quantita FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 AND quantita > 0',
          [row.oggetto_id]
        );
        sigleDisponibili = sigle;
      } else if (row.tipo_oggetto === 'KIT') {
        const [sci] = await pool.query(
          'SELECT articolo_id FROM kit_dettaglio WHERE kit_id = ? AND tipo_articolo = \'SCI\' LIMIT 1',
          [row.oggetto_id]
        );
        if (sci.length) {
          const [sigle] = await pool.query(
            'SELECT id, sigla, durezza, lunghezza, quantita FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 AND quantita > 0',
            [sci[0].articolo_id]
          );
          sigleDisponibili = sigle;
        }
      }

      const destinatarioNome = row.destinazione_tipo === 'PROMOTER'
        ? ((row.destinatario_nome || '') + ' ' + (row.destinatario_cognome || '')).trim()
        : (row.destinatario_nome || '');

      risultati.push({
        tipo: row.tipo_oggetto,
        ID: row.oggetto_id,
        siglaId: row.sigla_id,
        descrizione: row.descrizione || '',
        codice: row.codice || '',
        quantita: row.quantita,
        LUNGHEZZA: row.LUNGHEZZA || '',
        DUREZZA: row.DUREZZA || '',
        SIGLA_CORRENTE: row.SIGLA_CORRENTE || '',
        destinazioneTipo: row.destinazione_tipo,
        destinazioneId: row.destinazione_id,
        destinatarioNome: destinatarioNome,
        sigleDisponibili: sigleDisponibili,
        provenienzaTipo: row.provenienza_tipo,
        provenienzaId: row.provenienza_id,
        dataAssegnazione: row.data_assegnazione,
        categoriaNome: row.categoria_nome || null
      });
    }

    res.json({ success: true, oggetti: risultati });
  } catch (err) {
    console.error('Errore GET /oggetti/tutti:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.aggiornaCaricoSintesi = aggiornaCaricoSintesi;
module.exports.getDisponibilitaSigla = getDisponibilitaSigla;