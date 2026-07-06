const express = require('express');
const bcrypt = require('bcryptjs');   // <-- USO BCRYPTJS
const pool = require('../db');
const { generateToken } = require('../auth');
const router = express.Router();

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM utenti WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Credenziali errate' });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ success: false, message: 'Credenziali errate' });
        }
        const token = generateToken(user.id, user.username, user.ruolo);
        delete user.password_hash;
        res.json({ success: true, token, user });
    } catch (err) {
        console.error('Errore login:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;