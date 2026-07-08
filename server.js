const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/appointments', (req, res) => {
    const rows = db.prepare('SELECT * FROM appointments ORDER BY date_iso').all();
    res.json(rows);
  });

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`🌐 Calendario disponible en http://localhost:${PORT}`);
  });
}

module.exports = { startServer };