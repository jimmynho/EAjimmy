const express = require('express');
const eaji = require('./api-server');

// Serveur principal : le site de l'ONGD (/api/ongd) passe en premier, avec ses propres règles,
// puis tout le reste va à Eaji, qui fonctionne exactement comme avant.
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
require('./ongd-routes')(app);
app.use(eaji);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Eaji API démarrée sur le port ${PORT}`);
});
