const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');

// ============================================================
// GET /api/audit/log - Elenco operazioni con filtri
// ============================================================
router.get('/log', verifyToken, async (req, res) => {
  try {
    const { tabella, operazione, riga_id, limit = 100, offset = 0 } = req.query;
    let sql = `
      SELECT a.*, u.username AS utente_nome 
      FROM audit_log a
      LEFT JOIN utenti u ON a.utente_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (tabella) { sql += ' AND a.tabella = ?'; params.push(tabella); }
    if (operazione) { sql += ' AND a.operazione = ?'; params.push(operazione); }
    if (riga_id) { sql += ' AND a.riga_id = ?'; params.push(riga_id); }
    sql += ' ORDER BY a.data_ora DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Errore GET /audit/log:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// POST /api/audit/annulla/:id - Annulla un'operazione
// ============================================================
router.post('/annulla/:id', verifyToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Recupera il record di audit
    const [log] = await connection.query('SELECT * FROM audit_log WHERE id = ?', [req.params.id]);
    if (!log.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Record non trovato' });
    }
    const entry = log[0];
    if (entry.annullato) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Operazione già annullata' });
    }

    // 2. Gestione assegnazioni successive (per articoli o kit)
    const tipoOggetto = entry.tabella === 'articoli' ? 'ARTICOLO' : 'KIT';
    const [assegnazioni] = await connection.query(
      `SELECT * FROM carico_sintesi 
       WHERE tipo_oggetto = ? AND oggetto_id = ? 
       AND data_assegnazione > ?`,
      [tipoOggetto, entry.riga_id, entry.data_ora]
    );

    // Se ci sono assegnazioni successive, le rientriamo (cancellazione da carico_sintesi)
    if (assegnazioni.length > 0) {
      for (const ass of assegnazioni) {
        // Rimuovi la riga da carico_sintesi
        await connection.query(
          `DELETE FROM carico_sintesi 
           WHERE destinazione_tipo = ? AND destinazione_id = ? 
             AND tipo_oggetto = ? AND oggetto_id = ? 
             AND sigla_id <=> ? AND data_assegnazione = ?`,
          [ass.destinazione_tipo, ass.destinazione_id, ass.tipo_oggetto, ass.oggetto_id, ass.sigla_id, ass.data_assegnazione]
        );
        // Registra il rientro nei movimenti
        await connection.query(
          `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato)
           VALUES (NOW(), 'RIENTRO', CONCAT(?, '-', ?), NULL, ?, ?, ?, ?, 'Annullamento automatico', 'COMPLETATO')`,
          [ass.destinazione_tipo, ass.destinazione_id, ass.oggetto_id, ass.tipo_oggetto, ass.quantita, req.userId]
        );
      }
    }

    // 3. Esegui il rollback in base al tipo di tabella e operazione
    switch (entry.tabella) {
      case 'articoli':
        await rollbackArticolo(connection, entry, req.userId);
        break;
      case 'kit':
        await rollbackKit(connection, entry, req.userId);
        break;
      case 'sigle_articoli':
        await rollbackSigla(connection, entry, req.userId);
        break;
      case 'kit_dettaglio':
        await rollbackKitDettaglio(connection, entry, req.userId);
        break;
      default:
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'Tabella non supportata per annullamento' });
    }

    // 4. Segna il record di audit come annullato
    await connection.query('UPDATE audit_log SET annullato = 1 WHERE id = ?', [req.params.id]);

    await connection.commit();
    res.json({ success: true, message: 'Operazione annullata con successo' });
  } catch (err) {
    await connection.rollback();
    console.error('Errore annullamento:', err);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  } finally {
    connection.release();
  }
});

// ============================================================
// FUNZIONI DI ROLLBACK PER TABELLA
// ============================================================

async function rollbackArticolo(connection, entry, userId) {
  const id = entry.riga_id;
  switch (entry.operazione) {
    case 'CREAZIONE':
      // Elimina l'articolo e le sue sigle
      await connection.query('DELETE FROM sigle_articoli WHERE articolo_id = ?', [id]);
      await connection.query('DELETE FROM articoli WHERE articolo_id = ?', [id]);
      break;
    case 'MODIFICA':
      const prima = JSON.parse(entry.dati_prima);
      delete prima.articolo_id;
      delete prima.data_inserimento;
      delete prima.data_modifica;
      const setClauseArt = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const valuesArt = Object.values(prima);
      await connection.query(`UPDATE articoli SET ${setClauseArt} WHERE articolo_id = ?`, [...valuesArt, id]);
      break;
    case 'ELIMINAZIONE':
      const dati = JSON.parse(entry.dati_prima);
      delete dati.articolo_id;
      delete dati.data_inserimento;
      delete dati.data_modifica;
      await connection.query(`INSERT INTO articoli SET ?`, [dati]);
      break;
  }
}

async function rollbackKit(connection, entry, userId) {
  const id = entry.riga_id;
  switch (entry.operazione) {
    case 'CREAZIONE':
      // Elimina il kit e i dettagli
      await connection.query('DELETE FROM kit_dettaglio WHERE kit_id = ?', [id]);
      await connection.query('DELETE FROM kit WHERE id = ?', [id]);
      break;
    case 'MODIFICA':
      const prima = JSON.parse(entry.dati_prima);
      delete prima.id;
      delete prima.data_creazione;
      delete prima.data_modifica;
      const setClauseKit = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const valuesKit = Object.values(prima);
      await connection.query(`UPDATE kit SET ${setClauseKit} WHERE id = ?`, [...valuesKit, id]);
      break;
    case 'ELIMINAZIONE':
      const dati = JSON.parse(entry.dati_prima);
      delete dati.id;
      delete dati.data_creazione;
      delete dati.data_modifica;
      await connection.query(`INSERT INTO kit SET ?`, [dati]);
      break;
  }
}

async function rollbackSigla(connection, entry, userId) {
  const id = entry.riga_id;
  switch (entry.operazione) {
    case 'CREAZIONE':
      await connection.query('DELETE FROM sigle_articoli WHERE id = ?', [id]);
      break;
    case 'MODIFICA':
      const prima = JSON.parse(entry.dati_prima);
      delete prima.id;
      delete prima.articolo_id; // non modificare l'articolo_id
      const setClauseSig = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const valuesSig = Object.values(prima);
      await connection.query(`UPDATE sigle_articoli SET ${setClauseSig} WHERE id = ?`, [...valuesSig, id]);
      break;
    case 'ELIMINAZIONE':
      const dati = JSON.parse(entry.dati_prima);
      await connection.query(`INSERT INTO sigle_articoli SET ?`, [dati]);
      break;
  }
}

async function rollbackKitDettaglio(connection, entry, userId) {
  const id = entry.riga_id;
  switch (entry.operazione) {
    case 'CREAZIONE':
      await connection.query('DELETE FROM kit_dettaglio WHERE id = ?', [id]);
      break;
    case 'MODIFICA':
      const prima = JSON.parse(entry.dati_prima);
      delete prima.id;
      delete prima.kit_id;
      const setClauseDet = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const valuesDet = Object.values(prima);
      await connection.query(`UPDATE kit_dettaglio SET ${setClauseDet} WHERE id = ?`, [...valuesDet, id]);
      break;
    case 'ELIMINAZIONE':
      const dati = JSON.parse(entry.dati_prima);
      await connection.query(`INSERT INTO kit_dettaglio SET ?`, [dati]);
      break;
  }
}

module.exports = router;