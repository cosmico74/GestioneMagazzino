const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');
const db = require('../db');
const { ricalcolaQuantitaTotale } = require('./articoli');

const router = express.Router();

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
// HELPER: Verifica se un promoter può vendere a un cliente
// ============================================================
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

// ============================================================
// HELPER: Decrementa quantità in carico_sintesi (rimuove da assegnazione)
// ============================================================
async function decrementaCaricoSintesi(connection, tipoOggetto, oggettoId, siglaId, quantita, sorgenteTipo, sorgenteId) {
  if (sorgenteTipo === 'MAGAZZINO') return;

  const [rows] = await connection.query(
    `SELECT id, quantita FROM carico_sintesi 
     WHERE destinazione_tipo = ? AND destinazione_id = ? 
       AND tipo_oggetto = ? AND oggetto_id = ? 
       AND (sigla_id = ? OR (sigla_id IS NULL AND ? IS NULL))`,
    [sorgenteTipo, sorgenteId, tipoOggetto, oggettoId, siglaId, siglaId]
  );
  if (rows.length === 0) {
    throw new Error(`Oggetto non trovato in carico al soggetto (${sorgenteTipo} ${sorgenteId})`);
  }
  const row = rows[0];
  if (row.quantita < quantita) {
    throw new Error(`Quantità richiesta (${quantita}) supera quella in carico (${row.quantita})`);
  }
  const nuovaQuantita = row.quantita - quantita;
  if (nuovaQuantita === 0) {
    await connection.query(`DELETE FROM carico_sintesi WHERE id = ?`, [row.id]);
    console.log(`🗑️ Riga eliminata da carico_sintesi per ${tipoOggetto} ${oggettoId} da ${sorgenteTipo} ${sorgenteId}`);
  } else {
    await connection.query(`UPDATE carico_sintesi SET quantita = ? WHERE id = ?`, [nuovaQuantita, row.id]);
    console.log(`📉 Aggiornata quantità in carico_sintesi per ${tipoOggetto} ${oggettoId}: ${nuovaQuantita}`);
  }
}

// ============================================================
// HELPER: Decrementa articolo con sigla (da magazzino)
// ============================================================
async function decrementaArticoloConSigla(connection, articoloId, siglaId, quantita) {
  const [art] = await connection.query(
    'SELECT quantita_totale, quantita_obsoleta FROM articoli WHERE articolo_id = ? FOR UPDATE',
    [articoloId]
  );
  const giacenza = art[0].quantita_totale - (art[0].quantita_obsoleta || 0);
  if (giacenza < quantita) throw new Error(`Quantità insufficiente per articolo ${articoloId}`);

  if (siglaId) {
    const [sigla] = await connection.query(
      'SELECT quantita FROM sigle_articoli WHERE id = ? AND articolo_id = ? AND attivo = 1 FOR UPDATE',
      [siglaId, articoloId]
    );
    if (!sigla.length || sigla[0].quantita < quantita) {
      throw new Error(`Quantità insufficiente per la sigla ${siglaId}`);
    }
    await connection.query('UPDATE sigle_articoli SET quantita = quantita - ? WHERE id = ?', [quantita, siglaId]);
  } else {
    const [sigla] = await connection.query(
      'SELECT id FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 AND quantita >= ? FOR UPDATE',
      [articoloId, quantita]
    );
    if (!sigla.length) throw new Error(`Nessuna sigla con quantità sufficiente per articolo ${articoloId}`);
    await connection.query('UPDATE sigle_articoli SET quantita = quantita - ? WHERE id = ?', [quantita, sigla[0].id]);
  }
  await ricalcolaQuantitaTotale(connection, articoloId);
}

// ============================================================
// POST /api/vendite - Registra vendita
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  const { oggetti, clienteId, note, importo, data, sorgenteTipo, sorgenteId, magazzinoId } = req.body;
  if (!oggetti || !oggetti.length) {
    return res.status(400).json({ success: false, message: 'Nessun oggetto da vendere' });
  }
  if (!clienteId) {
    return res.status(400).json({ success: false, message: 'Seleziona un cliente' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    if (req.userRole !== 'admin') {
      const [user] = await connection.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
      const promoterId = user[0]?.riferimento_id;
      if (promoterId) {
        const canSell = await canPromoterSellTo(connection, promoterId, clienteId);
        if (!canSell) {
          throw new Error('Non hai i permessi per vendere a questo soggetto (livello insufficiente)');
        }
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

      if (sorgenteTipo && sorgenteTipo !== 'MAGAZZINO') {
        await decrementaCaricoSintesi(connection, tipoOggetto, oggettoId, siglaId || null, quantita, sorgenteTipo, sorgenteId);
      } else if (sorgenteTipo === 'MAGAZZINO' && magazzinoId) {
        if (tipoOggetto === 'ARTICOLO') {
          await decrementaArticoloConSigla(connection, oggettoId, siglaId || null, quantita);
        } else if (tipoOggetto === 'KIT') {
          const [kit] = await connection.query('SELECT quantita FROM kit WHERE id = ? FOR UPDATE', [oggettoId]);
          if (!kit.length || kit[0].quantita < quantita) {
            throw new Error(`Quantità kit ${oggettoId} insufficiente (disponibile ${kit[0]?.quantita || 0})`);
          }
          await connection.query('UPDATE kit SET quantita = quantita - ? WHERE id = ?', [quantita, oggettoId]);
        }
      } else {
        throw new Error('Sorgente non specificata correttamente');
      }

      const [movRes] = await connection.query(
        `INSERT INTO movimenti (data, tipo, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
         VALUES (?, 'VENDITA', ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [dataVendita, oggettoId, tipoOggetto, quantita, operatore, note || 'Vendita', siglaId || null]
      );

      await connection.query(
        `INSERT INTO vendite (cliente_id, movimento_id, importo, note, data)
         VALUES (?, ?, ?, ?, ?)`,
        [clienteId, movRes.insertId, importo || null, note || null, dataVendita]
      );

      // 🔥 Audit log
      const [venditaRow] = await connection.query('SELECT * FROM vendite WHERE movimento_id = ?', [movRes.insertId]);
      if (venditaRow.length) {
        await registraAudit(connection, 'vendite', 'CREAZIONE', movRes.insertId, null, venditaRow[0], req.userId);
      }

      totaleVendita += quantita;
    }

    await connection.commit();
    res.json({ success: true, message: `Vendita registrata per ${oggetti.length} oggetti (${totaleVendita} unità totali)` });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore vendita:', err);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  } finally {
    connection.release();
  }
});

module.exports = router;