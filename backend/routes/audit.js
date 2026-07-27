const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');
const { ricalcolaQuantitaTotale } = require('./articoli');
const { rimuoviDaKit, aggiungiInKit } = require('./kit');

// ============================================================
// MIDDLEWARE: solo utente con username 'admin'
// ============================================================
function onlyAdmin(req, res, next) {
  if (req.username !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accesso negato: solo l\'utente admin può visualizzare l\'audit log.' });
  }
  next();
}

// ============================================================
// GET /api/audit/log - Elenco operazioni con filtri
// ============================================================
router.get('/log', verifyToken, onlyAdmin, async (req, res) => {
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
// POST /api/audit/annulla/:id - Annulla un'operazione (solo admin)
// ============================================================
router.post('/annulla/:id', verifyToken, onlyAdmin, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

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

    // Gestione assegnazioni successive
    const tipoOggetto = entry.tabella === 'articoli' ? 'ARTICOLO' : 'KIT';
    const [assegnazioni] = await connection.query(
      `SELECT * FROM carico_sintesi 
       WHERE tipo_oggetto = ? AND oggetto_id = ? 
       AND data_assegnazione > ?`,
      [tipoOggetto, entry.riga_id, entry.data_ora]
    );

    if (assegnazioni.length > 0) {
      console.log(`⚠️ Trovate ${assegnazioni.length} assegnazioni successive da annullare`);
      for (const ass of assegnazioni) {
        await connection.query(
          `DELETE FROM carico_sintesi 
           WHERE destinazione_tipo = ? AND destinazione_id = ? 
             AND tipo_oggetto = ? AND oggetto_id = ? 
             AND sigla_id <=> ? AND data_assegnazione = ?`,
          [ass.destinazione_tipo, ass.destinazione_id, ass.tipo_oggetto, ass.oggetto_id, ass.sigla_id, ass.data_assegnazione]
        );
        await connection.query(
          `INSERT INTO movimenti (data, tipo, da_magazzino, a_magazzino, id_articolo_kit, tipo_oggetto, quantita, operatore, note, stato)
           VALUES (NOW(), 'RIENTRO', CONCAT(?, '-', ?), NULL, ?, ?, ?, ?, 'Annullamento automatico', 'COMPLETATO')`,
          [ass.destinazione_tipo, ass.destinazione_id, ass.oggetto_id, ass.tipo_oggetto, ass.quantita, req.userId]
        );
      }
    }

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

    await connection.query('UPDATE audit_log SET annullato = 1 WHERE id = ?', [req.params.id]);

    await connection.commit();
    res.json({ success: true, message: 'Operazione annullata con successo' });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore annullamento:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// FUNZIONI DI ROLLBACK PER TABELLA
// ============================================================

async function rollbackArticolo(connection, entry, userId) {
  const id = entry.riga_id;
  console.log(`🔄 Rollback articolo ${id}, operazione: ${entry.operazione}`);
  switch (entry.operazione) {
    case 'CREAZIONE': {
      await connection.query('DELETE FROM sigle_articoli WHERE articolo_id = ?', [id]);
      await connection.query('DELETE FROM articoli WHERE articolo_id = ?', [id]);
      break;
    }
    case 'MODIFICA': {
      const prima = JSON.parse(entry.dati_prima);
      delete prima.articolo_id;
      delete prima.data_inserimento;
      delete prima.data_modifica;
      const setClause = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const values = Object.values(prima);
      await connection.query(`UPDATE articoli SET ${setClause} WHERE articolo_id = ?`, [...values, id]);
      break;
    }
    case 'ELIMINAZIONE': {
      const dati = JSON.parse(entry.dati_prima);
      delete dati.articolo_id;
      delete dati.data_inserimento;
      delete dati.data_modifica;
      const columns = Object.keys(dati);
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(col => dati[col]);
      await connection.query(`INSERT INTO articoli (${columns.join(', ')}) VALUES (${placeholders})`, values);
      break;
    }
    default:
      throw new Error(`Operazione ${entry.operazione} non supportata per articoli`);
  }
}

async function rollbackKit(connection, entry, userId) {
  const id = entry.riga_id;
  console.log(`🔄 Rollback kit ${id}, operazione: ${entry.operazione}`);
  switch (entry.operazione) {
    case 'CREAZIONE': {
      const [dettagli] = await connection.query('SELECT * FROM kit_dettaglio WHERE kit_id = ?', [id]);
      for (const det of dettagli) {
        await rimuoviDaKit(connection, det.articolo_id, det.quantita);
      }

      const [movCarico] = await connection.query(
        `SELECT * FROM movimenti 
         WHERE tipo = 'KIT_DA_CARICO' AND id_articolo_kit = ? AND tipo_oggetto = 'KIT'`,
        [id]
      );

      if (movCarico.length > 0) {
        const daMagazzino = movCarico[0].da_magazzino;
        const [tipo, soggettoId] = daMagazzino.split('-');
        for (const det of dettagli) {
          await connection.query(
            `INSERT INTO carico_sintesi 
             (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, sigla_id, quantita, provenienza_tipo, provenienza_id, data_assegnazione)
             VALUES (?, ?, 'ARTICOLO', ?, ?, ?, 'MAGAZZINO', NULL, ?)`,
            [tipo, parseInt(soggettoId), det.articolo_id, det.sigla_id, det.quantita, new Date()]
          );
        }
      }

      await connection.query('DELETE FROM kit_dettaglio WHERE kit_id = ?', [id]);
      await connection.query('DELETE FROM kit WHERE id = ?', [id]);
      break;
    }
    case 'MODIFICA': {
      const prima = JSON.parse(entry.dati_prima);
      delete prima.id;
      delete prima.data_creazione;
      delete prima.data_modifica;
      const setClause = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const values = Object.values(prima);
      await connection.query(`UPDATE kit SET ${setClause} WHERE id = ?`, [...values, id]);
      break;
    }
    case 'ELIMINAZIONE': {
      const dati = JSON.parse(entry.dati_prima);
      delete dati.id;
      delete dati.data_creazione;
      delete dati.data_modifica;
      const columns = Object.keys(dati);
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(col => dati[col]);
      await connection.query(`INSERT INTO kit (${columns.join(', ')}) VALUES (${placeholders})`, values);
      break;
    }
    default:
      throw new Error(`Operazione ${entry.operazione} non supportata per kit`);
  }
}

async function rollbackKitDettaglio(connection, entry, userId) {
  const id = entry.riga_id;
  console.log(`🔄 Rollback kit_dettaglio ${id}, operazione: ${entry.operazione}`);
  switch (entry.operazione) {
    case 'CREAZIONE': {
      const [det] = await connection.query('SELECT * FROM kit_dettaglio WHERE id = ?', [id]);
      if (det.length) {
        await rimuoviDaKit(connection, det[0].articolo_id, det[0].quantita);
      }
      await connection.query('DELETE FROM kit_dettaglio WHERE id = ?', [id]);
      break;
    }
    case 'MODIFICA': {
      const prima = JSON.parse(entry.dati_prima);
      delete prima.id;
      delete prima.kit_id;
      const setClause = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const values = Object.values(prima);
      await connection.query(`UPDATE kit_dettaglio SET ${setClause} WHERE id = ?`, [...values, id]);
      break;
    }
    case 'ELIMINAZIONE': {
      const dati = JSON.parse(entry.dati_prima);
      const columns = Object.keys(dati);
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(col => dati[col]);
      await connection.query(`INSERT INTO kit_dettaglio (${columns.join(', ')}) VALUES (${placeholders})`, values);
      await aggiungiInKit(connection, dati.articolo_id, dati.quantita);
      break;
    }
    default:
      throw new Error(`Operazione ${entry.operazione} non supportata per kit_dettaglio`);
  }
}

async function rollbackSigla(connection, entry, userId) {
  const id = entry.riga_id;
  console.log(`🔄 Rollback sigla ${id}, operazione: ${entry.operazione}`);
  let articoloId;
  switch (entry.operazione) {
    case 'CREAZIONE': {
      const [sigla] = await connection.query('SELECT articolo_id FROM sigle_articoli WHERE id = ?', [id]);
      if (sigla.length) articoloId = sigla[0].articolo_id;
      await connection.query('DELETE FROM sigle_articoli WHERE id = ?', [id]);
      break;
    }
    case 'MODIFICA': {
      const prima = JSON.parse(entry.dati_prima);
      articoloId = prima.articolo_id;
      delete prima.id;
      delete prima.articolo_id;
      const setClause = Object.keys(prima).map(k => `${k} = ?`).join(', ');
      const values = Object.values(prima);
      await connection.query(`UPDATE sigle_articoli SET ${setClause} WHERE id = ?`, [...values, id]);
      break;
    }
    case 'ELIMINAZIONE': {
      const dati = JSON.parse(entry.dati_prima);
      articoloId = dati.articolo_id;
      const columns = Object.keys(dati);
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(col => dati[col]);
      await connection.query(`INSERT INTO sigle_articoli (${columns.join(', ')}) VALUES (${placeholders})`, values);
      break;
    }
    default:
      throw new Error(`Operazione ${entry.operazione} non supportata per sigle_articoli`);
  }
  if (articoloId) {
    await ricalcolaQuantitaTotale(connection, articoloId);
  }
}

module.exports = router;