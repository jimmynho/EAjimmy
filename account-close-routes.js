// Suppression du compte PAR L'UTILISATEUR lui-même (obligatoire pour le Play Store).
//
//  - Il confirme avec son mot de passe : le compte sera supprimé dans 30 jours.
//  - Il est déconnecté de tous ses appareils tout de suite.
//  - Pendant ces 30 jours, il peut se reconnecter et appuyer sur « Annuler la suppression ».
//  - Après 30 jours : le compte et toutes ses données sont effacés (même suppression que celle de l'administrateur).
//  - Un retrait d'argent en cours doit d'abord être terminé (pour qu'il reçoive son argent).
const DELAY_DAYS = 30;

const MIGRATIONS = [
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ',
];

function register({ app, db, pool, bcrypt, requireAuth, rateLimit, notify, deleteCreatorAccount, deleteCreatorFiles, isLeader }) {
  const state = async (id) => {
    const c = await db.query('SELECT deletion_scheduled_at FROM creators WHERE id = $1', [id]);
    return { scheduledAt: c && c.deletion_scheduled_at ? c.deletion_scheduled_at : null, delayDays: DELAY_DAYS };
  };

  app.get('/api/creators/me/deletion', requireAuth, async (req, res) => res.json(await state(req.creatorId)));

  app.post('/api/creators/me/deletion', requireAuth, rateLimit('delacc', 10, 60 * 60 * 1000), async (req, res) => {
    const c = await db.query('SELECT password_hash, deletion_scheduled_at FROM creators WHERE id = $1', [req.creatorId]);
    if (!c) return res.status(404).json({ error: 'Compte introuvable.' });
    if (!(await bcrypt.compare(String(req.body.password || ''), c.password_hash || ''))) {
      return res.status(403).json({ code: 'mot_de_passe', error: 'Mot de passe incorrect.' }); // 403 : l'appli ne le confond pas avec « déconnecté »
    }
    const pending = await db.query("SELECT COUNT(*)::int AS n FROM withdrawal_requests WHERE creator_id = $1 AND status = 'en_attente'", [req.creatorId]).catch(() => null);
    if (pending && pending.n > 0) {
      return res.status(409).json({ code: 'retrait_en_cours', error: 'Un retrait de ton argent est en cours : attends qu\'il soit payé, puis recommence.' });
    }
    const row = await db.query(
      `UPDATE creators SET deletion_scheduled_at = COALESCE(deletion_scheduled_at, now() + interval '${DELAY_DAYS} days'),
         session_version = session_version + 1 WHERE id = $1 RETURNING deletion_scheduled_at`, [req.creatorId]);
    await db.query('UPDATE user_sessions SET revoked_at = now() WHERE creator_id = $1 AND revoked_at IS NULL', [req.creatorId]).catch(() => {});
    await db.query('DELETE FROM push_subscriptions WHERE creator_id = $1', [req.creatorId]).catch(() => {}); // plus aucune notification
    console.log(`[Eaji] Suppression demandée par l'utilisateur ${req.creatorId} (le ${row.deletion_scheduled_at.toISOString().slice(0, 10)})`);
    res.json({ scheduledAt: row.deletion_scheduled_at, delayDays: DELAY_DAYS });
  });

  app.post('/api/creators/me/deletion/cancel', requireAuth, async (req, res) => {
    const c = await db.query('UPDATE creators SET deletion_scheduled_at = NULL WHERE id = $1 AND deletion_scheduled_at IS NOT NULL RETURNING id', [req.creatorId]);
    if (c && notify) await notify(req.creatorId, 'securite', '✅ La suppression de ton compte est annulée. Ton compte est conservé.').catch(() => {});
    res.json({ cancelled: Boolean(c), scheduledAt: null });
  });

  // Toutes les heures (sur un seul serveur) : on efface les comptes dont les 30 jours sont passés.
  async function runDue() {
    const rows = await db.all('SELECT id FROM creators WHERE deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= now() LIMIT 50');
    for (const r of rows) {
      try {
        if (await deleteCreatorAccount(pool, r.id)) {
          console.log(`[Eaji] Compte ${r.id} supprimé à la demande de l'utilisateur (30 jours passés)`);
          deleteCreatorFiles(r.id).catch((e) => console.error(`[Eaji] Effacement des fichiers du compte ${r.id} à refaire :`, e.message));
        }
      } catch (e) { console.error(`[Eaji] Suppression du compte ${r.id} à refaire :`, e.message); }
    }
    return rows.length;
  }
  if (process.env.NODE_ENV !== 'test') {
    setTimeout(() => { if (isLeader()) runDue().catch(() => {}); }, 30000).unref();
    setInterval(() => { if (isLeader()) runDue().catch(() => {}); }, 60 * 60 * 1000).unref();
  }
  return { runDue };
}

module.exports = { MIGRATIONS, register, DELAY_DAYS };
