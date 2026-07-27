const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 Avvio server...');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

console.log('📦 Caricamento routes...');

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend', 'Login.html'));
});

try {
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
    app.use('/api/audit', require('./routes/audit'));
    app.use('/api/backup', require('./routes/backup'));
    // ============================================================
// AVVIA SCHEDULER BACKUP
// ============================================================
try {
  const { startScheduler } = require('./routes/scheduler');
  startScheduler();
  console.log('✅ Scheduler backup avviato');
} catch (err) {
  console.warn('⚠️ Scheduler non avviato:', err.message);
}
    console.log('✅ Routes caricate.');
} catch (err) {
    console.error('❌ Errore nel caricamento delle routes:', err);
    process.exit(1);
}

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));