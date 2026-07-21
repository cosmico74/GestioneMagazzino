const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verifyToken } = require('../auth');
const { ricalcolaQuantitaTotale } = require('./articoli');
const { rimuoviDaKit, aggiungiInKit } = require('./kit');

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

    // Gestione assegnazioni successive (per articoli o kit)
    const tipoOggetto = entry.tabella === 'articoli' ? 'ARTICOLO' : 'KIT';
    const [assegnazioni] = await connection.query(
      `SELECT * FROM carico_sintesi 
       WHERE tipo_oggetto = ? AND oggetto_id = ? 
       AND data_assegnazione > ?`,
      [tipoOggetto, entry.riga_id, entry.data_ora]
    );

    if (assegnazioni.length > 0) {
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
    case 'CREAZIONE': {
      // Recupera i dettagli del kit
      const [dettagli] = await connection.query('SELECT * FROM kit_dettaglio WHERE kit_id = ?', [id]);
      
      // Sottrai le quantità in kit dagli articoli componenti
      for (const det of dettagli) {
        await rimuoviDaKit(connection, det.articolo_id, det.quantita);
      }

      // Verifica se il kit è stato creato da carico (movimento KIT_DA_CARICO)
      const [movCarico] = await connection.query(
        `SELECT * FROM movimenti 
         WHERE tipo = 'KIT_DA_CARICO' AND id_articolo_kit = ? AND tipo_oggetto = 'KIT'`,
        [id]
      );

      if (movCarico.length > 0) {
        // Creato da carico: ripristina gli articoli nel carico del soggetto
        const daMagazzino = movCarico[0].da_magazzino; // es. "PROMOTER-123"
        const [tipo, soggettoId] = daMagazzino.split('-');
        for (const det of dettagli) {
          await connection.query(
            `INSERT INTO carico_sintesi 
             (destinazione_tipo, destinazione_id, tipo_oggetto, oggetto_id, sigla_id, quantita, provenienza_tipo, provenienza_id, data_assegnazione)
             VALUES (?, ?, 'ARTICOLO', ?, ?, ?, 'MAGAZZINO', NULL, ?)`,
            [tipo, parseInt(soggettoId), det.articolo_id, det.sigla_id, det.quantita, new Date()]
          );
        }
      } else {
        // Creato da magazzino: ripristina le quantità delle sigle
        for (const det of dettagli) {
          await connection.query(
            'UPDATE sigle_articoli SET quantita = quantita + ? WHERE id = ?',
            [det.quantita, det.sigla_id]
          );
          await ricalcolaQuantitaTotale(connection, det.articolo_id);
        }
      }

      // Elimina kit e dettagli
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
      await connection.query(`INSERT INTO kit SET ?`, [dati]);
      break;
    }
  }
}

async function rollbackKitDettaglio(connection, entry, userId) {
  const id = entry.riga_id;
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
      await connection.query(`INSERT INTO kit_dettaglio SET ?`, [dati]);
      // Aggiorna la quantità in kit per l'articolo
      await aggiungiInKit(connection, dati.articolo_id, dati.quantita);
      break;
    }
  }
}

async function rollbackSigla(connection, entry, userId) {
  const id = entry.riga_id;
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
      await connection.query(`INSERT INTO sigle_articoli SET ?`, [dati]);
      break;
    }
  }
  if (articoloId) {
    await ricalcolaQuantitaTotale(connection, articoloId);
  }
}

module.exports = router;