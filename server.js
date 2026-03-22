const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const PORT   = 80;
const CONFIG = path.join(__dirname, 'data', 'dashboard-config.json');

app.use(express.json());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// GET dashboard config
app.get('/api/dashboard-config', (req, res) => {
  try {
    const data = fs.readFileSync(CONFIG, 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.json({ kpiIds: [], chartIds: [] });
  }
});

// POST dashboard config
app.post('/api/dashboard-config', (req, res) => {
  const { kpiIds, chartIds } = req.body;
  if (!Array.isArray(kpiIds) || !Array.isArray(chartIds)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  fs.writeFileSync(CONFIG, JSON.stringify({ kpiIds, chartIds }, null, 2));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Open http://localhost to view your website.`);
});
