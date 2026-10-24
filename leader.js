// Eaji — un seul « chef » parmi les serveurs (principal + secours) pour les tâches automatiques.
// Les deux serveurs répondent aux utilisateurs, mais les tâches automatiques (versements des périodes,
// vérification des paiements, surveillance des messages) ne tournent que sur UN serveur à la fois :
// celui qui détient un verrou dans la base de données. Si ce serveur s'arrête, sa connexion à la base
// se coupe, le verrou est libéré, et l'autre serveur reprend les tâches tout seul (en moins d'une minute).
// Sans start() (un seul serveur, ou essais), tout tourne normalement.
const { Client } = require('pg');

const LOCK_ID = 7342019; // numéro du verrou (toujours le même pour tous les serveurs Eaji)
let started = false, leader = false, client = null, busy = false;

function isLeader() { return !started || leader; }

async function tick(config) {
  if (busy) return;
  busy = true;
  try {
    if (!client) {
      const c = new Client(config);
      c.on('error', () => { leader = false; client = null; try { c.end(); } catch (e) { /* déjà fermé */ } });
      await c.connect();
      client = c;
    }
    if (leader) {
      await client.query('SELECT 1'); // toujours connecté : on reste chef
    } else {
      const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
      const was = leader;
      leader = Boolean(r.rows[0] && r.rows[0].ok);
      if (leader && !was) console.log('[Eaji] Ce serveur fait les tâches automatiques (chef).');
    }
  } catch (e) {
    if (leader) console.warn('[Eaji] Connexion du chef perdue :', e.message);
    leader = false;
    try { if (client) await client.end(); } catch (er) { /* rien */ }
    client = null;
  } finally { busy = false; }
}

function start(config) {
  if (started || !config || !config.connectionString) return;
  started = true;
  tick(config);
  const t = setInterval(() => tick(config), 20000);
  if (t.unref) t.unref();
}

module.exports = { start, isLeader, LOCK_ID };
