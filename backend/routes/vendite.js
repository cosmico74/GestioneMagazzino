const express = require('express');
const { verifyToken } = require('../auth');
const pool = require('../db');
const db = require('../db');
const { ricalcolaQuantitaTotale } = require('./articoli');
const { rimuoviDaKit } = require('./kit');

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
  } else {
    await connection.query(`UPDATE carico_sintesi SET quantita = ? WHERE id = ?`, [nuovaQuantita, row.id]);
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
    // Permessi
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

      // --- Gestione sorgente (rimozione da magazzino o da carico_sintesi) ---
      if (sorgenteTipo && sorgenteTipo !== 'MAGAZZINO') {
        // Soggetto: rimuovi da carico_sintesi
        await decrementaCaricoSintesi(connection, tipoOggetto, oggettoId, siglaId || null, quantita, sorgenteTipo, sorgenteId);
      } else if (sorgenteTipo === 'MAGAZZINO' && magazzinoId) {
        if (tipoOggetto === 'ARTICOLO') {
          await decrementaArticoloConSigla(connection, oggettoId, siglaId || null, quantita);
        } else if (tipoOggetto === 'KIT') {
          // Per i kit da magazzino, dobbiamo solo controllare che la quantità sia sufficiente
          const [kit] = await connection.query('SELECT quantita FROM kit WHERE id = ? FOR UPDATE', [oggettoId]);
          if (!kit.length || kit[0].quantita < quantita) {
            throw new Error(`Quantità kit ${oggettoId} insufficiente (disponibile ${kit[0]?.quantita || 0})`);
          }
          // Non aggiorniamo ancora, lo faremo dopo in modo uniforme
        }
      } else {
        throw new Error('Sorgente non specificata correttamente');
      }

      // --- Decremento comune per KIT (sia da magazzino che da soggetto) ---
      if (tipoOggetto === 'KIT') {
        // 1. Decrementa la quantità del kit
        await connection.query('UPDATE kit SET quantita = quantita - ? WHERE id = ?', [quantita, oggettoId]);

        // 2. Decrementa quantità totale e sigle per ogni articolo componente
        const [dettagli] = await connection.query(
          'SELECT articolo_id FROM kit_dettaglio WHERE kit_id = ?',
          [oggettoId]
        );
        for (const det of dettagli) {
          // Decrementa la quantità totale dell'articolo (come se lo vendessimo singolarmente)
          // siglaId = null per far scegliere automaticamente una sigla disponibile
          await decrementaArticoloConSigla(connection, det.articolo_id, null, quantita);
          // Aggiorna quantita_in_kit (perché il kit non esiste più)
          await rimuoviDaKit(connection, det.articolo_id, quantita);
        }
      }

      // --- Registra movimento e vendita ---
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

      // Audit
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

// ============================================================
// GET /api/vendite - Storico vendite
// ============================================================
router.get('/', verifyToken, async (req, res) => {
  try {
    const sql = `
      SELECT 
        v.id,
        v.data,
        v.importo,
        v.note AS vendita_note,
        s.nome AS cliente_nome,
        s.cognome AS cliente_cognome,
        m.tipo AS movimento_tipo,
        m.tipo_oggetto,
        m.quantita,
        m.id_articolo_kit AS oggetto_id,
        m.note AS movimento_note,
        m.operatore,
        COALESCE(a.descrizione, k.descrizione) AS oggetto_descrizione,
        COALESCE(a.codice, k.codice_kit) AS oggetto_codice
      FROM vendite v
      LEFT JOIN movimenti m ON v.movimento_id = m.id
      LEFT JOIN soggetti s ON v.cliente_id = s.id
      LEFT JOIN articoli a ON m.id_articolo_kit = a.articolo_id AND m.tipo_oggetto = 'ARTICOLO'
      LEFT JOIN kit k ON m.id_articolo_kit = k.id AND m.tipo_oggetto = 'KIT'
      ORDER BY v.data DESC
    `;
    const [rows] = await pool.query(sql);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Errore GET /vendite:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;