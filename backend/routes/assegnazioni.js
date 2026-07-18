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
// ENDPOINT: quantità assegnata per kit
// ============================================================
router.get('/quantita-assegnata-kit', verifyToken, async (req, res) => {
  const { kit_id } = req.query;
  if (!kit_id) return res.status(400).json({ error: 'kit_id richiesto' });
  const [rows] = await pool.query(
    'SELECT COALESCE(SUM(quantita), 0) AS quantita FROM carico_sintesi WHERE tipo_oggetto = \'KIT\' AND oggetto_id = ?',
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
// HELPER: Aggiorna carico_sintesi
// ============================================================
async function aggiornaCaricoSintesi(connection, destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, quantita, provenienzaTipo, provenienzaId, dataAssegnazione) {
  if (quantita === 0) {
    await connection.query(
      'DELETE FROM carico_sintesi WHERE destinazione_tipo = ? AND destinazione_id = ? AND tipo_oggetto = ? AND oggetto_id = ? AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))',
      [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId, siglaId]
    );
    return;
  }
  await connection.query(
    `INSERT INTO carico_sintesi (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, sigla_id, quantita, provenienza_tipo, provenienza_id, data_assegnazione)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE 
       quantita = VALUES(quantita),
       provenienza_tipo = VALUES(provenienza_tipo),
       provenienza_id = VALUES(provenienza_id),
       data_assegnazione = VALUES(data_assegnazione)`,
    [destinazioneTipo, destinazioneId, tipoOggetto, oggettoId, siglaId || null, quantita, provenienzaTipo, provenienzaId, dataAssegnazione || db.now()]
  );
}

// ============================================================
// USCITA BATCH (dal magazzino) - CON PERMESSI PER PROMOTER LIVELLO 1
// ============================================================
router.post('/uscita/batch', verifyToken, async (req, res) => {
  const { magazzinoId, destinazioneTipo, destinazioneId, note, oggetti } = req.body;
  if (!destinazioneTipo || !destinazioneId || !oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Parametri mancanti' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    // Verifica permessi: admin o promoter livello 1
    const userLevel = await getUserLevel(req.userId);
    if (req.userRole !== 'admin' && !(req.userRole === 'promoter' && userLevel === 1)) {
      throw new Error('Solo admin o promoter di livello 1 possono prelevare dal magazzino');
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
    // Controllo permessi per rientro: admin o promoter livello 1
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

      if (tipoOggetto === 'ARTICOLO') {
        await aggiornaCaricoSintesi(connection, itemDaTipo, itemDaId, 'ARTICOLO', oggettoId, siglaId, 0, null, null, null);
      } else if (tipoOggetto === 'KIT') {
        await aggiornaCaricoSintesi(connection, itemDaTipo, itemDaId, 'KIT', oggettoId, null, 0, null, null, null);
      }

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
// OTTIENI OGGETTI IN CARICO
// ============================================================
router.post('/oggetti', verifyToken, async (req, res) => {
  try {
    const { targetTipo, targetId, magazzino, includeReferenced } = req.body;
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
          sog.cognome AS destinatario_cognome
        FROM carico_sintesi cs
        LEFT JOIN articoli a ON cs.tipo_oggetto = 'ARTICOLO' AND cs.oggetto_id = a.articolo_id
        LEFT JOIN kit k ON cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id
        LEFT JOIN sigle_articoli s ON cs.sigla_id = s.id
        LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
        WHERE cs.destinazione_tipo = ? AND cs.destinazione_id = ? AND cs.quantita > 0
      `;
      const params = [tipo, id];
      if (magazzino) {
        sql += ' AND (a.magazzino = ? OR k.magazzino = ?)';
        params.push(magazzino, magazzino);
      }
      const [rows] = await connection.query(sql, params);
      const risultati = [];

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
          dataAssegnazione: row.data_assegnazione
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
// OTTIENI OGGETTI INVIATI
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
      WHERE cs.provenienza_tipo = ? AND cs.provenienza_id = ? AND cs.quantita > 0
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

module.exports = router;