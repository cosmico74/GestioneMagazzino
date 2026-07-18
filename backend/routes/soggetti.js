const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');
const bcrypt = require('bcrypt');

// Helper: sincronizza referenti
async function syncSoggettiReferenti(connection, soggettoId, referenteStr) {
  await connection.query('DELETE FROM soggetti_referenti WHERE soggetto_id = ?', [soggettoId]);
  if (referenteStr && referenteStr.trim() !== '') {
    const referentiIds = referenteStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    for (const refId of referentiIds) {
      await connection.query(
        'INSERT INTO soggetti_referenti (soggetto_id, referente_id) VALUES (?, ?)',
        [soggettoId, refId]
      );
    }
  }
}

// Helper: sincronizza magazzini associati
async function syncSoggettiMagazzini(connection, soggettoId, magazziniIds) {
  await connection.query('DELETE FROM soggetti_magazzini WHERE soggetto_id = ?', [soggettoId]);
  if (magazziniIds && magazziniIds.length) {
    for (const magId of magazziniIds) {
      await connection.query(
        'INSERT INTO soggetti_magazzini (soggetto_id, magazzino_id) VALUES (?, ?)',
        [soggettoId, magId]
      );
    }
  }
}

// ============================================================
// GET /api/soggetti/tipo/:tipo
// ============================================================
router.get('/tipo/:tipo', verifyToken, async (req, res) => {
  const { tipo } = req.params;
  const validi = ['PROMOTER', 'NEGOZIO', 'CLIENTE', 'AGENTE'];
  if (!validi.includes(tipo)) return res.status(400).json({ error: 'Tipo non valido' });
  try {
    if (req.userRole === 'admin') {
      const [rows] = await db.query(
        'SELECT id, tipo, nome, cognome, email, telefono FROM soggetti WHERE tipo = ? ORDER BY nome, cognome',
        [tipo]
      );
      return res.json(rows);
    }
    const [user] = await db.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
    if (!user.length || !user[0].riferimento_id) return res.json([]);
    const promoterId = user[0].riferimento_id;
    const [sog] = await db.query('SELECT livello FROM soggetti WHERE id = ?', [promoterId]);
    const livello = sog.length ? sog[0].livello : 0;

    let sql = `
      SELECT s.id, s.tipo, s.nome, s.cognome, s.email, s.telefono
      FROM soggetti s
      WHERE s.tipo = ? AND (
        s.id = ? OR
        EXISTS (SELECT 1 FROM soggetti_referenti WHERE referente_id = ? AND soggetto_id = s.id)
    `;
    const params = [tipo, promoterId, promoterId];

    if (livello === 1) {
      sql += ' OR s.livello = 1';
      if (tipo !== 'PROMOTER') {
        sql += ` OR EXISTS (
          SELECT 1 FROM soggetti_referenti sr
          WHERE sr.soggetto_id = s.id
          AND sr.referente_id IN (
            SELECT id FROM soggetti WHERE tipo = 'PROMOTER' AND livello = 1
          )
        )`;
      }
    } else if (livello === 2) {
      sql += ' OR s.livello = 3';
    }
    sql += ' ) ORDER BY s.tipo, s.nome, s.cognome';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// ============================================================
// GET /api/soggetti/visibili
// ============================================================
router.get('/visibili', verifyToken, async (req, res) => {
  try {
    const [userRows] = await db.query('SELECT ruolo, riferimento_id FROM utenti WHERE id = ?', [req.userId]);
    if (userRows.length === 0) return res.status(404).json({ error: 'Utente non trovato' });
    const user = userRows[0];
    const ruolo = user.ruolo;
    let livello = null, mioId = null;
    if (user.riferimento_id) {
      const [sog] = await db.query('SELECT id, livello FROM soggetti WHERE id = ?', [user.riferimento_id]);
      if (sog.length) { mioId = sog[0].id; livello = sog[0].livello; }
    }
    if (ruolo === 'admin') {
      const [rows] = await db.query('SELECT id, tipo, nome, cognome, livello FROM soggetti ORDER BY tipo, nome');
      return res.json(rows);
    }
    let query = 'SELECT s.id, s.tipo, s.nome, s.cognome, s.livello FROM soggetti s WHERE 1=1';
    const params = [];
    if (ruolo === 'promoter') {
      query += ' AND (s.id = ? OR EXISTS (SELECT 1 FROM soggetti_referenti WHERE referente_id = ? AND soggetto_id = s.id)';
      params.push(mioId, mioId);
      if (livello !== null && livello > 1) { query += ' OR s.livello > ?'; params.push(livello); }
      else if (livello === 1) { query += ' OR s.livello IN (2,3)'; }
      query += ' )';
    } else {
      query += ' AND s.id = ?';
      params.push(mioId);
    }
    query += ' ORDER BY s.tipo, s.nome, s.cognome';
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/soggetti/:id
// ============================================================
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*, u.id AS utente_id, u.username AS utente_username, u.ruolo AS utente_ruolo
      FROM soggetti s
      LEFT JOIN utenti u ON u.riferimento_id = s.id
      WHERE s.id = ?
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Soggetto non trovato' });
    const row = rows[0];
    const [refRows] = await db.query('SELECT referente_id FROM soggetti_referenti WHERE soggetto_id = ?', [req.params.id]);
    const referentiIds = refRows.map(r => r.referente_id);
    const [magRows] = await db.query('SELECT magazzino_id FROM soggetti_magazzini WHERE soggetto_id = ?', [req.params.id]);
    const magazziniIds = magRows.map(r => r.magazzino_id);
    const { utente_id, utente_username, utente_ruolo, ...soggetto } = row;
    if (utente_id) {
      soggetto.utenteAssociato = { id: utente_id, username: utente_username, ruolo: utente_ruolo };
    }
    soggetto.referenti = referentiIds;
    soggetto.magazziniAssociati = magazziniIds;
    res.json(soggetto);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/soggetti (lista completa)
// ============================================================
router.get('/', verifyToken, async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      const [user] = await db.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
      if (!user.length || !user[0].riferimento_id) return res.json([]);
      const promoterId = user[0].riferimento_id;
      const [sog] = await db.query('SELECT livello FROM soggetti WHERE id = ?', [promoterId]);
      const livello = sog.length ? sog[0].livello : 0;

      let sql = `
        SELECT s.*, u.id AS utente_id, u.username AS utente_username, u.ruolo AS utente_ruolo
        FROM soggetti s
        LEFT JOIN utenti u ON u.riferimento_id = s.id
        WHERE s.id = ? OR EXISTS (SELECT 1 FROM soggetti_referenti WHERE referente_id = ? AND soggetto_id = s.id)
      `;
      const params = [promoterId, promoterId];
      if (livello === 1) {
        sql += ' OR s.livello IN (2, 3)';
      } else if (livello === 2) {
        sql += ' OR s.livello = 3';
      }
      sql += ' ORDER BY s.tipo, s.nome, s.cognome';
      const [rows] = await db.query(sql, params);
      const soggettiConReferenti = [];
      for (const row of rows) {
        const [refRows] = await db.query('SELECT referente_id FROM soggetti_referenti WHERE soggetto_id = ?', [row.id]);
        const referentiIds = refRows.map(r => r.referente_id);
        const [magRows] = await db.query('SELECT magazzino_id FROM soggetti_magazzini WHERE soggetto_id = ?', [row.id]);
        const magazziniIds = magRows.map(r => r.magazzino_id);
        const { utente_id, utente_username, utente_ruolo, ...soggetto } = row;
        if (utente_id) {
          soggetto.utenteAssociato = { id: utente_id, username: utente_username, ruolo: utente_ruolo };
        }
        soggetto.referenti = referentiIds;
        soggetto.magazziniAssociati = magazziniIds;
        soggettiConReferenti.push(soggetto);
      }
      return res.json(soggettiConReferenti);
    }

    const [rows] = await db.query(`
      SELECT s.*, u.id AS utente_id, u.username AS utente_username, u.ruolo AS utente_ruolo
      FROM soggetti s
      LEFT JOIN utenti u ON u.riferimento_id = s.id
      ORDER BY s.tipo, s.nome, s.cognome
    `);
    const soggettiConReferenti = [];
    for (const row of rows) {
      const [refRows] = await db.query('SELECT referente_id FROM soggetti_referenti WHERE soggetto_id = ?', [row.id]);
      const referentiIds = refRows.map(r => r.referente_id);
      const [magRows] = await db.query('SELECT magazzino_id FROM soggetti_magazzini WHERE soggetto_id = ?', [row.id]);
      const magazziniIds = magRows.map(r => r.magazzino_id);
      const { utente_id, utente_username, utente_ruolo, ...soggetto } = row;
      if (utente_id) {
        soggetto.utenteAssociato = { id: utente_id, username: utente_username, ruolo: utente_ruolo };
      }
      soggetto.referenti = referentiIds;
      soggetto.magazziniAssociati = magazziniIds;
      soggettiConReferenti.push(soggetto);
    }
    res.json(soggettiConReferenti);
  } catch (err) {
    console.error('Errore GET /soggetti:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/soggetti
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  const { tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo, livello, utenteAssociato, nuovaPassword, magazziniAssociati, creaUtente } = req.body;
  if (!tipo || !nome) return res.status(400).json({ error: 'Tipo e nome sono obbligatori' });

  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    let referenteStr = null;
    if (referente) {
      if (Array.isArray(referente)) referenteStr = referente.join(',');
      else if (typeof referente === 'string') referenteStr = referente;
    }

    if (req.userRole !== 'admin') {
      const [user] = await connection.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
      if (user.length && user[0].riferimento_id) {
        const promoterId = user[0].riferimento_id;
        let refIds = referenteStr ? referenteStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
        if (!refIds.includes(promoterId)) {
          refIds.push(promoterId);
        }
        referenteStr = refIds.join(',');
      }
    }

    const [result] = await connection.query(
      `INSERT INTO soggetti (tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo, livello)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null, referenteStr, note || null, attivo !== undefined ? attivo : 1, livello || null]
    );
    const soggettoId = result.insertId;

    await syncSoggettiReferenti(connection, soggettoId, referenteStr);
    await syncSoggettiMagazzini(connection, soggettoId, magazziniAssociati || []);

    let utenteCreato = null;

    // Gestione utente associato (solo admin può associare un utente esistente)
    if (utenteAssociato) {
      if (req.userRole !== 'admin') {
        throw new Error('Solo admin può associare un utente esistente');
      }
      const [userExists] = await connection.query('SELECT id FROM utenti WHERE id = ? AND (riferimento_id IS NULL OR riferimento_id = ?)', [utenteAssociato, soggettoId]);
      if (userExists.length === 0) throw new Error('Utente selezionato non valido o già associato');
      await connection.query('UPDATE utenti SET riferimento_id = ? WHERE id = ?', [soggettoId, utenteAssociato]);
    } else if (tipo === 'PROMOTER' && creaUtente === true) {
      // Crea l'utente solo se esplicitamente richiesto
      const username = email ? email.split('@')[0] : (nome + (cognome || '')).toLowerCase().replace(/\s/g, '');
      // Se username è vuoto, usa un fallback
      const finalUsername = username || 'user_' + soggettoId;
      const password = nuovaPassword && nuovaPassword.trim() ? nuovaPassword.trim() : Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(password, 10);
      const nomeVisualizzato = (nome + ' ' + (cognome || '')).trim();
      const [userResult] = await connection.query(
        `INSERT INTO utenti (username, password_hash, ruolo, riferimento_id, nome_visualizzato, email)
         VALUES (?, ?, 'promoter', ?, ?, ?)`,
        [finalUsername, hashedPassword, soggettoId, nomeVisualizzato, email || null]
      );
      utenteCreato = { username: finalUsername, password, id: userResult.insertId };
    }

    await connection.commit();
    res.json({ success: true, id: soggettoId, utenteCreato });
  } catch (err) {
    await connection.rollback();
    console.error('❌ Errore POST /soggetti:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  } finally {
    connection.release();
  }
});

// ============================================================
// PUT /api/soggetti/:id
// ============================================================
router.put('/:id', verifyToken, async (req, res) => {
  const { tipo, nome, cognome, email, telefono, indirizzo, citta, cap, regione, referente, note, attivo, livello, utenteAssociato, magazziniAssociati, creaUtente } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    if (req.userRole !== 'admin') {
      const [user] = await connection.query('SELECT riferimento_id FROM utenti WHERE id = ?', [req.userId]);
      if (!user.length || !user[0].riferimento_id) {
        return res.status(403).json({ error: 'Non autorizzato' });
      }
      const promoterId = user[0].riferimento_id;
      const [ref] = await connection.query(
        'SELECT 1 FROM soggetti_referenti WHERE soggetto_id = ? AND referente_id = ?',
        [req.params.id, promoterId]
      );
      if (!ref.length) {
        return res.status(403).json({ error: 'Non sei referente di questo soggetto' });
      }
    }

    let referenteStr = null;
    if (referente) {
      if (Array.isArray(referente)) referenteStr = referente.join(',');
      else if (typeof referente === 'string') referenteStr = referente;
    }

    await connection.query(
      `UPDATE soggetti SET
        tipo = ?, nome = ?, cognome = ?, email = ?, telefono = ?, indirizzo = ?, citta = ?, cap = ?, regione = ?,
        referente = ?, note = ?, attivo = ?, livello = ?
       WHERE id = ?`,
      [tipo, nome, cognome || null, email || null, telefono || null, indirizzo || null, citta || null, cap || null, regione || null,
       referenteStr, note || null, attivo, livello || null, req.params.id]
    );
    await syncSoggettiReferenti(connection, req.params.id, referenteStr);
    await syncSoggettiMagazzini(connection, req.params.id, magazziniAssociati || []);

    // Rimuovi associazione utente precedente (solo admin)
    if (req.userRole === 'admin') {
      await connection.query('UPDATE utenti SET riferimento_id = NULL WHERE riferimento_id = ?', [req.params.id]);
      if (utenteAssociato) {
        const [userExists] = await connection.query('SELECT id FROM utenti WHERE id = ? AND (riferimento_id IS NULL OR riferimento_id = ?)', [utenteAssociato, req.params.id]);
        if (userExists.length === 0) throw new Error('Utente selezionato non valido o già associato');
        await connection.query('UPDATE utenti SET riferimento_id = ? WHERE id = ?', [req.params.id, utenteAssociato]);
      }
    }

    // Gestione creazione utente su modifica (solo per promoter e solo se richiesto)
    if (tipo === 'PROMOTER' && creaUtente === true && req.userRole === 'admin') {
      const [existingUser] = await connection.query('SELECT id FROM utenti WHERE riferimento_id = ?', [req.params.id]);
      if (existingUser.length === 0) {
        const username = email ? email.split('@')[0] : (nome + (cognome || '')).toLowerCase().replace(/\s/g, '');
        const finalUsername = username || 'user_' + req.params.id;
        const password = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(password, 10);
        const nomeVisualizzato = (nome + ' ' + (cognome || '')).trim();
        await connection.query(
          `INSERT INTO utenti (username, password_hash, ruolo, riferimento_id, nome_visualizzato, email)
           VALUES (?, ?, 'promoter', ?, ?, ?)`,
          [finalUsername, hashedPassword, req.params.id, nomeVisualizzato, email || null]
        );
        // Nota: la password non viene restituita nella risposta PUT
        // Si potrebbe loggare, ma non è sicuro. L'admin può reimpostarla da Gestione Utenti.
        console.log(`🔑 Utente creato per soggetto ${req.params.id} con username ${finalUsername}`);
      }
    }

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error('Errore PUT /soggetti:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// DELETE /api/soggetti/:id (solo admin)
// ============================================================
router.delete('/:id', verifyToken, async (req, res) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Solo admin può eliminare soggetti' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('UPDATE utenti SET riferimento_id = NULL WHERE riferimento_id = ?', [req.params.id]);
    await connection.query('DELETE FROM soggetti_referenti WHERE soggetto_id = ? OR referente_id = ?', [req.params.id, req.params.id]);
    await connection.query('DELETE FROM soggetti_magazzini WHERE soggetto_id = ?', [req.params.id]);
    const [result] = await connection.query('DELETE FROM soggetti WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) throw new Error('Soggetto non trovato');
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error('Errore DELETE /soggetti:', err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

module.exports = router;