const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');
const { ricalcolaQuantitaTotale } = require('./articoli');
const { rimuoviDaKit } = require('./kit');

const router = express.Router();

/** Helper per la registrazione degli audit log nel DB */
async function registraAudit(connection, tabella, operazione, rigaId, datiPrima, datiDopo, utenteId) {
  await connection.query(
    `INSERT INTO audit_log (tabella, operazione, riga_id, dati_prima, dati_dopo, utente_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tabella, operazione, rigaId, JSON.stringify(datiPrima), JSON.stringify(datiDopo), utenteId]
  );
}

/** Verifica se un promoter ha i permessi per vendere a un determinato cliente in base al livello gerarchico */
async function canPromoterSellTo(connection, promoterId, clienteId) {
  const [p] = await connection.query('SELECT livello FROM soggetti WHERE id = ?', [promoterId]);
  if (!p.length) return false;
  const livelloPromoter = p[0].livello;
  const [c] = await connection.query('SELECT tipo FROM soggetti WHERE id = ?', [clienteId]);
  if (!c.length) return false;
  const tipoCliente = c[0].tipo;
  if (tipoCliente === 'PROMOTER') {
    const [t] = await connection.query('SELECT livello FROM soggetti WHERE id = ?', [clienteId]);
    const livelloCliente = t[0]?.livello || 0;
    if (livelloPromoter === 1) return true;
    if (livelloPromoter === 2) return livelloCliente === 3;
    if (livelloPromoter === 3) return false;
    return false;
  }
  return true;
}

/** Sottrae la quantità venduta dal carico di un soggetto (es. da un promoter) */
async function decrementaCaricoSintesi(connection, tipoOggetto, oggettoId, siglaId, quantita, sorgenteTipo, sorgenteId) {
  if (sorgenteTipo === 'MAGAZZINO') return;
  const [rows] = await connection.query(
    `SELECT id, quantita FROM carico_sintesi 
     WHERE destinazione_tipo = ? AND destinazione_id = ? 
       AND tipo_oggetto = ? AND oggetto_id = ? 
       AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))`,
    [sorgenteTipo, sorgenteId, tipoOggetto, oggettoId, siglaId, siglaId]
  );
  if (rows.length === 0) throw new Error(`Oggetto non trovato in carico al soggetto (${sorgenteTipo} ${sorgenteId})`);
  const row = rows[0];
  if (row.quantita < quantita) throw new Error(`Quantità richiesta (${quantita}) supera quella in carico (${row.quantita})`);
  const nuovaQuantita = row.quantita - quantita;
  if (nuovaQuantita === 0) await connection.query(`DELETE FROM carico_sintesi WHERE id = ?`, [row.id]);
  else await connection.query(`UPDATE carico_sintesi SET quantita = ? WHERE id = ?`, [nuovaQuantita, row.id]);
}

/** Sottrae la quantità venduta dal magazzino, gestendo la giacenza sugli articoli e sulle sigle */
async function decrementaArticoloConSigla(connection, articoloId, siglaId, quantita) {
  const [art] = await connection.query('SELECT quantita_totale, quantita_obsoleta FROM articoli WHERE articolo_id = ? FOR UPDATE', [articoloId]);
  const giacenza = art[0].quantita_totale - (art[0].quantita_obsoleta || 0);
  if (giacenza < quantita) throw new Error(`Quantità insufficiente per articolo ${articoloId}`);
  if (siglaId) {
    const [sigla] = await connection.query('SELECT quantita FROM sigle_articoli WHERE id = ? AND articolo_id = ? AND attivo = 1 FOR UPDATE', [siglaId, articoloId]);
    if (!sigla.length || sigla[0].quantita < quantita) throw new Error(`Quantità insufficiente per la sigla ${siglaId}`);
    await connection.query('UPDATE sigle_articoli SET quantita = quantita - ? WHERE id = ?', [quantita, siglaId]);
  } else {
    const [sigla] = await connection.query('SELECT id FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 AND quantita >= ? FOR UPDATE', [articoloId, quantita]);
    if (!sigla.length) throw new Error(`Nessuna sigla con quantità sufficiente per articolo ${articoloId}`);
    await connection.query('UPDATE sigle_articoli SET quantita = quantita - ? WHERE id = ?', [quantita, sigla[0].id]);
  }
  await ricalcolaQuantitaTotale(connection, articoloId);
}

/** POST /api/vendite - Crea una nuova vendita e imposta lo stato 'IN_CONSEGNA' di default */
router.post('/', verifyToken, async (req, res) => {
  const { oggetti, clienteId, note, importo, data, sorgenteTipo, sorgenteId, magazzinoId, tipoDocumento, dataDocumento, numeroDocumento } = req.body;
  if (!oggetti || !oggetti.length) return res.status(400).json({ success: false, message: 'Nessun oggetto da vendere' });
  if (!clienteId) return res.status(400).json({ success: false, message: 'Seleziona un cliente' });
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    if (req.userRole !== 'admin') {
      const [user] = await connection.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
      const promoterId = user[0]?.riferimento_id;
      if (promoterId) {
        const canSell = await canPromoterSellTo(connection, promoterId, clienteId);
        if (!canSell) throw new Error('Non hai i permessi per vendere a questo soggetto (livello insufficiente)');
      }
    }
    const [user] = await connection.query('SELECT username FROM utenti WHERE id = ?', [req.userId]);
    const operatore = user[0].username;
    const now = data ? new Date(data) : new Date();
    const dataVendita = now.toISOString().slice(0, 19).replace('T', ' ');
    let totaleVendita = 0;
    for (const item of oggetti) {
      const { tipoOggetto, oggettoId, quantita, siglaId } = item;
      if (!quantita || quantita <= 0) continue;
      if (sorgenteTipo && sorgenteTipo !== 'MAGAZZINO') await decrementaCaricoSintesi(connection, tipoOggetto, oggettoId, siglaId || null, quantita, sorgenteTipo, sorgenteId);
      else if (sorgenteTipo === 'MAGAZZINO' && magazzinoId) {
        if (tipoOggetto === 'ARTICOLO') await decrementaArticoloConSigla(connection, oggettoId, siglaId || null, quantita);
        else if (tipoOggetto === 'KIT') {
          const [kit] = await connection.query('SELECT quantita FROM kit WHERE id = ? FOR UPDATE', [oggettoId]);
          if (!kit.length || kit[0].quantita < quantita) throw new Error(`Quantità kit ${oggettoId} insufficiente (disponibile ${kit[0]?.quantita || 0})`);
        }
      } else throw new Error('Sorgente non specificata correttamente');
      if (tipoOggetto === 'KIT') {
        await connection.query('UPDATE kit SET quantita = quantita - ? WHERE id = ?', [quantita, oggettoId]);
        const [dettagli] = await connection.query('SELECT articolo_id FROM kit_dettaglio WHERE kit_id = ?', [oggettoId]);
        for (const det of dettagli) {
          await decrementaArticoloConSigla(connection, det.articolo_id, null, quantita);
          await rimuoviDaKit(connection, det.articolo_id, quantita);
        }
      }
      const [movRes] = await connection.query(
        `INSERT INTO movimenti (data, tipo, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
         VALUES (?, 'VENDITA', ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [dataVendita, oggettoId, tipoOggetto, quantita, operatore, note || 'Vendita', siglaId || null]
      );
      await connection.query(
        `INSERT INTO vendite (cliente_id, movimento_id, importo, note, data, stato_consegna, tipo_documento, data_documento, numero_documento)
         VALUES (?, ?, ?, ?, ?, 'IN_CONSEGNA', ?, ?, ?)`,
        [clienteId, movRes.insertId, importo || null, note || null, dataVendita, tipoDocumento || null, dataDocumento || null, numeroDocumento || null]
      );
      const [venditaRow] = await connection.query('SELECT * FROM vendite WHERE movimento_id = ?', [movRes.insertId]);
      if (venditaRow.length) await registraAudit(connection, 'vendite', 'CREAZIONE', movRes.insertId, null, venditaRow[0], req.userId);
      totaleVendita += quantita;
    }
    await connection.commit();
    res.json({ success: true, message: `Vendita registrata con stato 'In Consegna'. ${oggetti.length} oggetti (${totaleVendita} unità totali)` });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore vendita:', err);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  } finally { connection.release(); }
});

/** GET /api/vendite - Recupera lo storico, con filtro opzionale per stato_consegna */
router.get('/', verifyToken, async (req, res) => {
  try {
    const { stato_consegna } = req.query;
    let whereClause = '';
    let params = [];
    if (stato_consegna) { whereClause = 'WHERE v.stato_consegna = ?'; params.push(stato_consegna); }
    const sql = `
      SELECT 
        v.id, v.data, v.importo, v.note AS vendita_note, v.stato_consegna, v.tipo_documento, v.data_documento, v.numero_documento,
        s.nome AS cliente_nome, s.cognome AS cliente_cognome,
        m.tipo_oggetto, m.quantita, m.id_articolo_kit AS oggetto_id, m.operatore,
        COALESCE(a.descrizione, k.descrizione) AS oggetto_descrizione,
        COALESCE(a.codice, k.codice_kit) AS oggetto_codice
      FROM vendite v
      LEFT JOIN movimenti m ON v.movimento_id = m.id
      LEFT JOIN soggetti s ON v.cliente_id = s.id
      LEFT JOIN articoli a ON m.id_articolo_kit = a.articolo_id AND m.tipo_oggetto = 'ARTICOLO'
      LEFT JOIN kit k ON m.id_articolo_kit = k.id AND m.tipo_oggetto = 'KIT'
      ${whereClause}
      ORDER BY v.data DESC
    `;
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) { console.error('Errore GET /vendite:', err); res.status(500).json({ success: false, message: err.message }); }
});

/** GET /api/vendite/:id - Recupera i dettagli di una singola vendita */
router.get('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    const sql = `
      SELECT v.id, v.data, v.importo, v.note, v.cliente_id, v.stato_consegna, v.tipo_documento, v.data_documento, v.numero_documento,
      s.nome AS cliente_nome, s.cognome AS cliente_cognome
      FROM vendite v LEFT JOIN soggetti s ON v.cliente_id = s.id WHERE v.id = ?
    `;
    const [rows] = await pool.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Vendita non trovata' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { console.error('Errore GET /vendite/:id:', err); res.status(500).json({ success: false, message: err.message }); }
});

/** PUT /api/vendite/:id - Aggiorna nota, importo, documenti e stato di consegna di una singola vendita */
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { stato_consegna, tipo_documento, data_documento, numero_documento, note, importo } = req.body;
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [vendita] = await connection.query('SELECT * FROM vendite WHERE id = ? FOR UPDATE', [id]);
    if (!vendita.length) throw new Error('Vendita non trovata');
    const datiPrima = { ...vendita[0] };
    await connection.query(
      'UPDATE vendite SET stato_consegna = COALESCE(?, stato_consegna), tipo_documento = ?, data_documento = ?, numero_documento = ?, note = ?, importo = ? WHERE id = ?',
      [stato_consegna, tipo_documento || null, data_documento || null, numero_documento || null, note || null, importo || null, id]
    );
    // 🔥 Se è stata appena effettuata la consegna, cancella la sigla associata al movimento
    if (stato_consegna === 'CONSEGNATO') {
      await connection.query(
        `UPDATE movimenti SET sigla_id = NULL WHERE id = (SELECT movimento_id FROM vendite WHERE id = ?)`,
        [id]
      );
    }
    const [datiDopo] = await connection.query('SELECT * FROM vendite WHERE id = ?', [id]);
    await registraAudit(connection, 'vendite', 'MODIFICA', id, datiPrima, datiDopo[0], req.userId);
    await connection.commit();
    res.json({ success: true, message: 'Vendita aggiornata con successo' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore aggiornamento vendita:', err);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  } finally { connection.release(); }
});

/** POST /api/vendite/consegna-massiva - Effettua la consegna di più vendite selezionate in un colpo solo */
router.post('/consegna-massiva', verifyToken, async (req, res) => {
  const { ids, note } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ success: false, message: 'Nessuna vendita selezionata per la consegna' });
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    for (const id of ids) {
      const [vendita] = await connection.query('SELECT * FROM vendite WHERE id = ? FOR UPDATE', [id]);
      if (!vendita.length) continue;
      const datiPrima = { ...vendita[0] };
      const nuovaNota = note ? (vendita[0].note ? vendita[0].note + ' | ' + note : note) : vendita[0].note;
      await connection.query(
        'UPDATE vendite SET stato_consegna = "CONSEGNATO", note = ? WHERE id = ?',
        [nuovaNota, id]
      );
      // 🔥 Cancella la sigla associata al movimento di questa vendita
      await connection.query(
        `UPDATE movimenti SET sigla_id = NULL WHERE id = ?`,
        [vendita[0].movimento_id]
      );
      const [datiDopo] = await connection.query('SELECT * FROM vendite WHERE id = ?', [id]);
      await registraAudit(connection, 'vendite', 'CONSEGNA_MASSIVA', id, datiPrima, datiDopo[0], req.userId);
    }
    await connection.commit();
    res.json({ success: true, message: `Consegna effettuata con successo per ${ids.length} vendite selezionate.` });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore consegna massiva:', err);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  } finally { connection.release(); }
});

module.exports = router;