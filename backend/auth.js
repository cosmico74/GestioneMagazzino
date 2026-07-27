const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

function generateToken(userId, username, ruolo) {
    return jwt.sign({ userId, username, ruolo }, JWT_SECRET, { expiresIn: '8h' });
}

async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'Token mancante' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.ruolo;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token non valido' });
    }
}

module.exports = { generateToken, verifyToken };