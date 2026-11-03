const app = require('./api-server');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Eaji API démarrée sur le port ${PORT}`);
});
