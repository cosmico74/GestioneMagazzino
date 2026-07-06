const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');
const { ricalcolaQuantitaTotale } = require('./articoli');

const router = express.Router();

// ============================================================
// HELPER: Verifica se un promoter può vendere a un cliente
// ============================================================
async function canPromoterSellTo(connection, promoterId, clienteId) {
  // Ottieni livello del promoter
  const [p] = await connection.query('SELECT livello FROM soggetti WHERE id = ?', [promoterId]);
  if (!p.length) return false;
  const livelloPromoter = p[0].livello;

  // Ottieni tipo del cliente
  const [c] = await connection.query('SELECT tipo FROM soggetti WHERE id = ?', [clienteId]);
  if (!c.length) return false;
  const tipoCliente = c[0].tipo;

  // I clienti possono essere di tipo CLIENTE o NEGOZIO (a volte anche AGENTE)
  // Un promoter può sempre vendere a CLIENTE, NEGOZIO e AGENTE
  // Ma se il cliente è un PROMOTER, applica le stesse regole di assegnazione
  if (tipoCliente === 'PROMOTER') {
    // Usa la stessa logica di canPromoterAssignTo
    const [t] = await connection.query('SELECT livello FROM soggetti WHERE id = ?', [clienteId]);
    const livelloCliente = t[0]?.livello || 0;
    if (livelloPromoter === 1) return true;
    if (livelloPromoter === 2) return livelloCliente === 3;
    if (livelloPromoter === 3) return false;
    return false;
  }
  // Per clienti non promoter, permesso sempre
  return true;
}

// ============================================================
// DECREMENTA ARTICOLO CON SIGLA (helper)
// ============================================================
async function decrementaArticoloConSigla(connection, articoloId, siglaId, quantita) {
  const [art] = await connection.query('SELECT quantita_totale, quantita_obsoleta FROM articoli WHERE articolo_id = ? FOR UPDATE', [articoloId]);
  const giacenza = art[0].quantita_totale - (art[0].quantita_obsoleta || 0);
  if (giacenza < quantita) throw new Error('Quantità insufficiente');

  if (siglaId) {
    const [sigla] = await connection.query('SELECT quantita FROM sigle_articoli WHERE id = ? AND articolo_id = ? AND attivo = 1 FOR UPDATE', [siglaId, articoloId]);
    if (!sigla.length || sigla[0].quantita < quantita) throw new Error('Quantità insufficiente per la sigla');
    await connection.query('UPDATE sigle_articoli SET quantita = quantita - ? WHERE id = ?', [quantita, siglaId]);
  } else {
    const [sigla] = await connection.query('SELECT id FROM sigle_articoli WHERE articolo_id = ? AND attivo = 1 AND quantita >= ? FOR UPDATE', [articoloId, quantita]);
    if (!sigla.length) throw new Error('Nessuna sigla con quantità sufficiente');
    await connection.query('UPDATE sigle_articoli SET quantita = quantita - ? WHERE id = ?', [quantita, sigla[0].id]);
  }
  await ricalcolaQuantitaTotale(connection, articoloId);
}

// ============================================================
// VENDITA (con controllo di livello)
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  const { oggetti, clienteId, note, importo } = req.body;
  if (!oggetti || !oggetti.length) return res.status(400).json({ success: false, message: 'Nessun oggetto da vendere' });
  if (!clienteId) return res.status(400).json({ success: false, message: 'Seleziona un cliente' });

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    // Verifica permessi per promoter
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
    const now = db.now();

    for (const item of oggetti) {
      const { tipoOggetto, oggettoId, quantita, siglaId } = item;
      if (!quantita || quantita <= 0) continue;

      if (tipoOggetto === 'ARTICOLO') {
        await decrementaArticoloConSigla(connection, oggettoId, siglaId || null, quantita);
      } else if (tipoOggetto === 'KIT') {
        const [kit] = await connection.query('SELECT quantita FROM kit WHERE id = ? FOR UPDATE', [oggettoId]);
        if (!kit.length || kit[0].quantita < quantita) throw new Error(`Quantità kit ${oggettoId} insufficiente`);
        await connection.query('UPDATE kit SET quantita = quantita - ? WHERE id = ?', [quantita, oggettoId]);
      }

      const [movRes] = await connection.query(
        `INSERT INTO movimenti (data, tipo, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato, sigla_id)
         VALUES (?, 'VENDITA', ?, ?, ?, ?, ?, 'COMPLETATO', ?)`,
        [now, oggettoId, tipoOggetto, quantita, operatore, note || 'Vendita', siglaId || null]
      );

      await connection.query(
        `INSERT INTO vendite (cliente_id, movimento_id, importo, note, data)
         VALUES (?, ?, ?, ?, ?)`,
        [clienteId, movRes.insertId, importo || null, note || null, now]
      );
    }

    await connection.commit();
    res.json({ success: true, message: `Vendita registrata per ${oggetti.length} oggetti` });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;