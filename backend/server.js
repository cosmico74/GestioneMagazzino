const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Servi i file statici dalla cartella frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// ===== ROUTE PER LA ROOT (/) =====
// Quando un utente visita https://iltuoprogetto.onrender.com/
// viene servito il file Login.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/Login.html'));
});

// ===== ROUTE API =====
app.use('/api/auth', require('./routes/auth'));
app.use('/api/articoli', require('./routes/articoli'));
app.use('/api/kit', require('./routes/kit'));
app.use('/api/assegnazioni', require('./routes/assegnazioni'));
app.use('/api/vendite', require('./routes/vendite'));
app.use('/api/soggetti', require('./routes/soggetti'));
app.use('/api/utenti', require('./routes/utenti'));
app.use('/api/anagrafiche', require('./routes/anagrafiche'));
app.use('/api/report', require('./routes/report'));
app.use('/api/movimenti', require('./routes/movimenti'));

// ===== AVVIA IL SERVER =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Visita http://localhost:${PORT} per il Login`);
});