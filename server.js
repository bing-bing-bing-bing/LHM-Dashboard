const express = require('express');
const path = require('path');

const app = express();
const PORT = 80;

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Open http://localhost to view your website.`);
});
