const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { getSettings, saveSettings } = require('./settings');

function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/appointments', (req, res) => {
    const rows = db.prepare('SELECT * FROM appointments ORDER BY date_iso').all();
    res.json(rows);
  });

  app.get('/api/settings', (req, res) => {
    res.json(getSettings());
  });

  app.put('/api/settings', (req, res) => {
    try {
      res.json(saveSettings(req.body));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`🌐 Calendario disponible en http://localhost:${PORT}`);
  });
}

module.exports = { startServer };
