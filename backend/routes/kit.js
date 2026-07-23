const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');
const { canUserUseMagazzino } = require('./articoli');
const { aggiornaCaricoSintesi } = require('./assegnazioni');

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
// HELPER: calcola la giacenza reale di un articolo
// ============================================================
async function getGiacenzaArticolo(connection, articoloId) {
  const [art] = await connection.query(
    'SELECT quantita_totale, quantita_in_kit, quantita_obsoleta FROM articoli WHERE articolo_id = ?',
    [articoloId]
  );
  if (!art.length) return 0;
  const [assegnato] = await connection.query(
    'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE tipo_oggetto = \'ARTICOLO\' AND oggetto_id = ?',
    [articoloId]
  );
  return art[0].quantita_totale - art[0].quantita_in_kit - art[0].quantita_obsoleta - assegnato[0].totale;
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
// GET /api/kit - Elenco kit con informazioni di assegnazione e catena
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
         LIMIT 1) AS sigla_sci,
        u1.username AS creato_da_username,
        u2.username AS modificato_da_username,
        -- Catena di assegnazioni (tutte le righe in carico_sintesi per questo kit)
        (SELECT JSON_ARRAYAGG(
           JSON_OBJECT(
             'tipo', cs.destinazione_tipo,
             'id', cs.destinazione_id,
             'nome', CONCAT(
               COALESCE(sog.nome, ''),
               IF(sog.cognome IS NOT NULL AND sog.cognome != '', CONCAT(' ', sog.cognome), '')
             ),
             'data', cs.data_assegnazione
           )
         ) FROM carico_sintesi cs
         LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
         WHERE cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
         ORDER BY cs.data_assegnazione ASC
        ) AS assegnazioni_json,
        -- Ultimo destinatario (l'ultimo della catena)
        (SELECT CONCAT(
           COALESCE(sog.nome, ''),
           IF(sog.cognome IS NOT NULL AND sog.cognome != '', CONCAT(' ', sog.cognome), '')
         ) FROM carico_sintesi cs
         LEFT JOIN soggetti sog ON sog.tipo = cs.destinazione_tipo AND sog.id = cs.destinazione_id
         WHERE cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
         ORDER BY cs.data_assegnazione DESC
         LIMIT 1
        ) AS ultimo_destinatario_nome,
        -- Tipo e ID dell'ultimo destinatario
        (SELECT cs.destinazione_tipo FROM carico_sintesi cs
         WHERE cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
         ORDER BY cs.data_assegnazione DESC
         LIMIT 1
        ) AS ultimo_destinatario_tipo,
        (SELECT cs.destinazione_id FROM carico_sintesi cs
         WHERE cs.tipo_oggetto = 'KIT' AND cs.oggetto_id = k.id AND cs.quantita > 0
         ORDER BY cs.data_assegnazione DESC
         LIMIT 1
        ) AS ultimo_destinatario_id
      FROM kit k
      LEFT JOIN utenti u1 ON k.creato_da = u1.id
      LEFT JOIN utenti u2 ON k.modificato_da = u2.id
      ORDER BY k.id DESC
    `);

    // Parse JSON per le assegnazioni
    const risultato = kits.map(k => {
      let assegnazioni = [];
      if (k.assegnazioni_json) {
        try {
          assegnazioni = JSON.parse(k.assegnazioni_json);
        } catch(e) {}
      }

      let ultimoDestinatario = 'In magazzino';
      if (k.ultimo_destinatario_nome && k.ultimo_destinatario_nome.trim() !== '') {
        ultimoDestinatario = k.ultimo_destinatario_nome.trim();
      } else if (k.ultimo_destinatario_tipo && k.ultimo_destinatario_id) {
        // Fallback: se il nome è vuoto, mostra il tipo+id
        ultimoDestinatario = k.ultimo_destinatario_tipo + ' ' + k.ultimo_destinatario_id;
      }

      return {
        ...k,
        lunghezza_sci: k.lunghezza_sci || '',
        sigla_sci: k.sigla_sci || '',
        assegnazioni: assegnazioni,
        ultimo_destinatario: ultimoDestinatario,
        ultimo_destinatario_tipo: k.ultimo_destinatario_tipo,
        ultimo_destinatario_id: k.ultimo_destinatario_id
      };
    });

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
// POST /api/kit - Crea un nuovo kit
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

    // 1. Recupera lo sci
    const [sci] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [sci_id]);
    if (!sci.length) throw new Error('Sci non trovato');

    // 2. Calcola la giacenza reale dello sci
    const giacenzaSci = await getGiacenzaArticolo(connection, sci_id);

    // 3. Calcola la quantità totale richiesta per lo sci in questo kit
    let quantitaTotaleRichiesta = 0;
    for (const riga of righe) {
      quantitaTotaleRichiesta += riga.quantita;
    }

    // 4. Verifica che la quantità richiesta non superi la giacenza
    if (quantitaTotaleRichiesta > giacenzaSci) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Quantità richiesta (${quantitaTotaleRichiesta}) supera la giacenza disponibile (${giacenzaSci}) per lo sci`
      });
    }

    // 5. Verifica la giacenza di ogni sigla
    for (const riga of righe) {
      const { sigla_id, quantita } = riga;
      const [sigla] = await connection.query(
        'SELECT quantita FROM sigle_articoli WHERE id = ? AND attivo = 1',
        [sigla_id]
      );
      if (!sigla.length) throw new Error(`Sigla ID ${sigla_id} non trovata`);
      
      const [usedInKit] = await connection.query(
        'SELECT COALESCE(SUM(quantita), 0) AS totale FROM kit_dettaglio WHERE sigla_id = ?',
        [sigla_id]
      );
      const [assegnato] = await connection.query(
        'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE sigla_id = ? AND tipo_oggetto = ?',
        [sigla_id, 'ARTICOLO']
      );
      const giacenzaSigla = sigla[0].quantita - usedInKit[0].totale - assegnato[0].totale;
      if (quantita > giacenzaSigla) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Quantità richiesta (${quantita}) per la sigla supera la giacenza disponibile (${giacenzaSigla})`
        });
      }
    }

    // 6. Genera codice kit
    const [maxIdRow] = await connection.query('SELECT MAX(id) AS maxId FROM kit');
    const nextSeq = (maxIdRow[0].maxId || 0) + 1;
    const codiceKit = `KIT-${magazzino}-${String(nextSeq).padStart(4, '0')}`;
    const descKit = await generaDescrizioneKit(connection, sci[0], righe);

    const now = db.now();
    const [kitRes] = await connection.query(
      `INSERT INTO kit (codice_kit, descrizione, quantita, magazzino, note, data_creazione, data_modifica, creato_da, modificato_da)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [codiceKit, descKit, magazzino, note || null, now, now, req.userId, req.userId]
    );
    const kitId = kitRes.insertId;

    let quantitaTotaleKit = 0;
    for (const riga of righe) {
      const { sigla_id, attacco_id, skistopper_id, quantita } = riga;
      if (!sigla_id || !attacco_id) throw new Error('Ogni riga deve avere sigla e attacco');

      // Aggiorna quantita_in_kit per lo sci
      await aggiungiInKit(connection, sci_id, quantita);
      // Aggiorna quantita_in_kit per l'attacco
      await aggiungiInKit(connection, attacco_id, quantita);
      // Se lo skistopper è selezionato, aggiorna anche quello
      if (skistopper_id) {
        await aggiungiInKit(connection, skistopper_id, quantita);
      }

      // Inserisci dettaglio SCI
      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SCI\', ?, ?, ?)',
        [kitId, sci_id, sigla_id, quantita]
      );
      // Inserisci dettaglio ATTACCHI
      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'ATTACCHI\', ?, NULL, ?)',
        [kitId, attacco_id, quantita]
      );
      // Inserisci dettaglio SKISTOPPER (solo se selezionato)
      if (skistopper_id) {
        await connection.query(
          'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SKISTOPPER\', ?, NULL, ?)',
          [kitId, skistopper_id, quantita]
        );
      }
      quantitaTotaleKit += quantita;
    }

    await connection.query('UPDATE kit SET quantita = ? WHERE id = ?', [quantitaTotaleKit, kitId]);

    // Audit
    const [newRow] = await connection.query('SELECT * FROM kit WHERE id = ?', [kitId]);
    await registraAudit(connection, 'kit', 'CREAZIONE', kitId, null, newRow[0], req.userId);

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

    // Recupera username dell'operatore
    const [userRow] = await connection.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
    const operatore = userRow.length ? userRow[0].username : 'sconosciuto';

    // Raccogli gli articoli selezionati per categoria
    const articoliSelezionati = {};
    let sciId = null, attaccoId = null, skistopperId = null;
    let sciSiglaId = null, attaccoSiglaId = null, skistopperSiglaId = null;
    let quantitaSci = 0, quantitaAttacco = 0, quantitaSkistopper = 0;

    // Verifica che tutti gli articoli siano in carico al soggetto con quantità sufficiente
    for (const item of oggetti) {
      const [art] = await connection.query(
        'SELECT a.articolo_id, a.descrizione, a.lunghezza, c.nome AS categoria_nome FROM articoli a LEFT JOIN categorie c ON a.categoria = c.categoria_id WHERE a.articolo_id = ?',
        [item.oggettoId]
      );
      if (!art.length) throw new Error(`Articolo ${item.oggettoId} non trovato`);
      const categoria = art[0].categoria_nome || '';

      const [carico] = await connection.query(
        `SELECT quantita FROM carico_sintesi 
         WHERE destinazione_tipo = ? AND destinazione_id = ? 
           AND tipo_oggetto = 'ARTICOLO' AND oggetto_id = ? 
           AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))`,
        [soggettoTipo, soggettoId, item.oggettoId, item.siglaId || null, item.siglaId || null]
      );
      if (!carico.length) {
        throw new Error(`Articolo ${art[0].descrizione} non trovato in carico al soggetto`);
      }
      if (carico[0].quantita < item.quantita) {
        throw new Error(`Quantità richiesta (${item.quantita}) per ${art[0].descrizione} supera quella in carico (${carico[0].quantita})`);
      }

      // Classifica per categoria
      if (categoria.toLowerCase() === 'sci') {
        if (sciId) throw new Error('Puoi selezionare un solo sci per kit');
        sciId = item.oggettoId;
        sciSiglaId = item.siglaId;
        quantitaSci = item.quantita;
        articoliSelezionati[sciId] = { ...item, categoria, articolo: art[0], quantitaInCarico: carico[0].quantita };
      } else if (categoria.toLowerCase() === 'attacchi') {
        if (attaccoId) throw new Error('Puoi selezionare un solo attacco per kit');
        attaccoId = item.oggettoId;
        attaccoSiglaId = item.siglaId;
        quantitaAttacco = item.quantita;
        articoliSelezionati[attaccoId] = { ...item, categoria, articolo: art[0], quantitaInCarico: carico[0].quantita };
      } else if (categoria.toLowerCase() === 'skistoppers') {
        if (skistopperId) throw new Error('Puoi selezionare un solo skistopper per kit');
        skistopperId = item.oggettoId;
        skistopperSiglaId = item.siglaId;
        quantitaSkistopper = item.quantita;
        articoliSelezionati[skistopperId] = { ...item, categoria, articolo: art[0], quantitaInCarico: carico[0].quantita };
      } else {
        throw new Error(`Categoria ${categoria} non valida per composizione kit`);
      }
    }

    if (!sciId) throw new Error('Devi selezionare almeno uno sci');
    if (!attaccoId) throw new Error('Devi selezionare almeno un attacco');

    const qta = quantitaSci;
    if (quantitaAttacco !== qta) throw new Error('La quantità dello sci e dell\'attacco deve essere la stessa');
    if (skistopperId && quantitaSkistopper !== qta) throw new Error('La quantità dello skistopper deve essere uguale a quella dello sci');

    // 1. Sottrai le quantità dal carico del soggetto
    for (const id in articoliSelezionati) {
      const item = articoliSelezionati[id];
      const nuovaQuantita = item.quantitaInCarico - item.quantita;
      await aggiornaCaricoSintesi(
        connection,
        soggettoTipo,
        soggettoId,
        'ARTICOLO',
        item.oggettoId,
        item.siglaId,
        nuovaQuantita,
        null, null, null
      );
    }

    // 2. Crea il kit
    const [maxIdRow] = await connection.query('SELECT MAX(id) AS maxId FROM kit');
    const nextSeq = (maxIdRow[0].maxId || 0) + 1;
    const codiceKit = `KIT-${magazzinoId}-${String(nextSeq).padStart(4, '0')}`;

    const [sci] = await connection.query('SELECT descrizione, lunghezza FROM articoli WHERE articolo_id = ?', [sciId]);
    const righe = [{ attacco_id: attaccoId }];
    const descKit = await generaDescrizioneKit(connection, sci[0], righe);

    const now = db.now();
    const [kitRes] = await connection.query(
      `INSERT INTO kit (codice_kit, descrizione, quantita, magazzino, note, data_creazione, data_modifica, creato_da, modificato_da)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [codiceKit, descKit, qta, magazzinoId, note || null, now, now, req.userId, req.userId]
    );
    const kitId = kitRes.insertId;

    // 3. Inserisci dettagli kit
    await connection.query(
      'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SCI\', ?, ?, ?)',
      [kitId, sciId, sciSiglaId, qta]
    );
    await connection.query(
      'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'ATTACCHI\', ?, NULL, ?)',
      [kitId, attaccoId, qta]
    );
    if (skistopperId) {
      await connection.query(
        'INSERT INTO kit_dettaglio (kit_id, tipo_articolo, articolo_id, sigla_id, quantita) VALUES (?, \'SKISTOPPER\', ?, NULL, ?)',
        [kitId, skistopperId, qta]
      );
    }

    // 4. Aggiorna quantita_in_kit
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

    // 6. Registra movimento (usa 'TRASFERIMENTO' come tipo, con nota)
    const notaMovimento = note ? `Creazione kit da carico: ${note}` : 'Creazione kit da carico';
    await connection.query(
      `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
       VALUES (?, 'TRASFERIMENTO', ?, ?, ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
      [now, `${soggettoTipo}-${soggettoId}`, `${destinazioneTipo}-${destinazioneId}`, kitId, 'KIT', qta, operatore, notaMovimento, null]
    );

    // Audit
    const [newKit] = await connection.query('SELECT * FROM kit WHERE id = ?', [kitId]);
    await registraAudit(connection, 'kit', 'CREAZIONE', kitId, null, newKit[0], req.userId);

    const [dettagliInseriti] = await connection.query('SELECT * FROM kit_dettaglio WHERE kit_id = ?', [kitId]);
    for (const det of dettagliInseriti) {
      await registraAudit(connection, 'kit_dettaglio', 'CREAZIONE', det.id, null, det, req.userId);
    }

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

// ============================================================
// HELPER: livello utente per permessi (usato in /da-carico)
// ============================================================
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

    // Recupera i vecchi dati per audit
    const [oldRow] = await connection.query('SELECT * FROM kit WHERE id = ?', [id]);

    // 1. Recupera i vecchi dettagli e rimuovili (rilascia le quantità)
    const [oldDetails] = await connection.query('SELECT * FROM kit_dettaglio WHERE kit_id = ?', [id]);
    for (const det of oldDetails) {
      await rimuoviDaKit(connection, det.articolo_id, det.quantita);
    }
    await connection.query('DELETE FROM kit_dettaglio WHERE kit_id = ?', [id]);

    // 2. Recupera lo sci
    const [sci] = await connection.query('SELECT * FROM articoli WHERE articolo_id = ?', [sci_id]);
    if (!sci.length) throw new Error('Sci non trovato');

    // 3. Calcola la giacenza reale dello sci (dopo aver rimosso i vecchi dettagli)
    const giacenzaSci = await getGiacenzaArticolo(connection, sci_id);

    // 4. Calcola la quantità totale richiesta per lo sci nel nuovo kit
    let quantitaTotaleRichiesta = 0;
    for (const riga of righe) {
      quantitaTotaleRichiesta += riga.quantita;
    }

    // 5. Verifica che la quantità richiesta non superi la giacenza
    if (quantitaTotaleRichiesta > giacenzaSci) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Quantità richiesta (${quantitaTotaleRichiesta}) supera la giacenza disponibile (${giacenzaSci}) per lo sci`
      });
    }

    // 6. Verifica la giacenza di ogni sigla
    for (const riga of righe) {
      const { sigla_id, quantita } = riga;
      const [sigla] = await connection.query(
        'SELECT quantita FROM sigle_articoli WHERE id = ? AND attivo = 1',
        [sigla_id]
      );
      if (!sigla.length) throw new Error(`Sigla ID ${sigla_id} non trovata`);
      
      const [usedInKit] = await connection.query(
        'SELECT COALESCE(SUM(quantita), 0) AS totale FROM kit_dettaglio WHERE sigla_id = ?',
        [sigla_id]
      );
      const [assegnato] = await connection.query(
        'SELECT COALESCE(SUM(quantita), 0) AS totale FROM carico_sintesi WHERE sigla_id = ? AND tipo_oggetto = ?',
        [sigla_id, 'ARTICOLO']
      );
      const giacenzaSigla = sigla[0].quantita - usedInKit[0].totale - assegnato[0].totale;
      if (quantita > giacenzaSigla) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Quantità richiesta (${quantita}) per la sigla supera la giacenza disponibile (${giacenzaSigla})`
        });
      }
    }

    // 7. Genera nuova descrizione kit
    const descKit = await generaDescrizioneKit(connection, sci[0], righe);

    // 8. Inserisci i nuovi dettagli
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
      `UPDATE kit SET magazzino = ?, note = ?, quantita = ?, descrizione = ?, data_modifica = NOW(), modificato_da = ? WHERE id = ?`,
      [magazzino, note || null, quantitaTotaleKit, descKit, req.userId, id]
    );

    // Audit
    const [newRow] = await connection.query('SELECT * FROM kit WHERE id = ?', [id]);
    await registraAudit(connection, 'kit', 'MODIFICA', id, oldRow[0], newRow[0], req.userId);

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
  const { note } = req.body;
  if (note === undefined) {
    return res.status(400).json({ error: 'Campo note mancante' });
  }
  const connection = await db.getConnection();
  try {
    // Recupera i vecchi dati per audit
    const [oldRow] = await connection.query('SELECT * FROM kit WHERE id = ?', [req.params.id]);

    await connection.query('UPDATE kit SET note = ?, data_modifica = NOW() WHERE id = ?', [note, req.params.id]);

    // Audit
    const [newRow] = await connection.query('SELECT * FROM kit WHERE id = ?', [req.params.id]);
    await registraAudit(connection, 'kit', 'MODIFICA', req.params.id, oldRow[0], newRow[0], req.userId);

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

    // Recupera i vecchi dati per audit
    const [oldRow] = await connection.query('SELECT * FROM kit WHERE id = ?', [req.params.id]);
    await registraAudit(connection, 'kit', 'ELIMINAZIONE', req.params.id, oldRow[0], null, req.userId);

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

// === ESPORTAZIONE PER AUDIT ===
module.exports.ricalcolaQuantitaInKit = ricalcolaQuantitaInKit;
module.exports.aggiungiInKit = aggiungiInKit;
module.exports.rimuoviDaKit = rimuoviDaKit;