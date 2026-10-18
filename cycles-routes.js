// Eaji — rémunération par période d'abonnement Premium (règle interne, non affichée aux utilisateurs).
//
//  • Une période = un mois, du jour d'activation du Premium au même jour du mois suivant (1 mois, 3 mois ou
//    1 an : même procédure, un mois après l'autre).
//  • Le 25e jour de chaque période (5 jours avant l'échéance d'un Premium d'un mois), Eaji regroupe les
//    publications mises en ligne pendant la période, compte leurs vues et les abonnés, calcule le montant
//    et l'ajoute automatiquement aux gains du créateur.
//  • Une publication n'est rémunérée qu'une seule fois, dans sa période. Ensuite ses vues ne rapportent
//    plus rien au créateur (Eaji en profite), et sur ses ventes et cadeaux il ne reçoit plus que 30 %.
//  • Les publications d'avant le Premium ne comptent pas. Un contenu identique déjà publié (même fichier
//    ou même lien) n'est jamais rémunéré : tout l'argent qu'il rapporte va à l'administrateur principal.
//  • Chaque jour, le créateur voit sa rémunération (vues et abonnés) grandir « en attente ». Elle ne devient
//    disponible (retrait, abonnement, cadeaux) que le jour du versement, après le contrôle : fausses vues
//    retirées, copies écartées, règle des 70 % de vues évaluée. Les ventes et cadeaux restent disponibles
//    tout de suite. Des fausses vues découvertes → mise en garde automatique, puis avertissements.
const crypto = require('crypto');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 24 * 3600 * 1000;
const CYCLE_DAYS = 30;
const PAYOUT_DAY = 25;          // versement le 25e jour de la période (5 jours avant la fin du mois)
const DAYS_BEFORE_END = 5;
const SHARE_NEW = 0.60;         // publication de la période en cours
const SHARE_OLD = 0.30;         // publication déjà rémunérée (ou d'avant le Premium)
// Fausses vues : contrôlées le jour du versement.
const FARM_ACCOUNTS = 4;        // au moins 4 comptes (qui regardent ce créateur) sur un même téléphone = comptes en série
const WARN_MIN = 10;            // mise en garde dès 10 fausses vues représentant au moins 5 % des vues…
const WARN_RATIO = 0.05;
const WARN_ALWAYS = 200;        // … ou dès 200 fausses vues, quel que soit le total
const DEVICE_RE = /^[A-Za-z0-9-]{16,64}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

const MIGRATIONS = [
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS monetized_at TIMESTAMPTZ',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS payout_cycle_id UUID',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS file_fingerprint TEXT',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS source_fingerprint TEXT',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS duplicate_of UUID',
  'CREATE INDEX IF NOT EXISTS content_items_fp ON content_items (file_fingerprint)',
  'CREATE INDEX IF NOT EXISTS content_items_srcfp ON content_items (source_fingerprint)',
  `CREATE TABLE IF NOT EXISTS payout_cycles (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     window_start TIMESTAMPTZ NOT NULL,
     cycle_start TIMESTAMPTZ NOT NULL,
     payout_at TIMESTAMPTZ NOT NULL,
     status TEXT NOT NULL DEFAULT 'en_cours' CHECK (status IN ('en_cours', 'paye', 'sans_gain')),
     contents INTEGER, cycle_views INTEGER, subscribers INTEGER, paid_subscribers INTEGER,
     base_amount_usd NUMERIC(12,2), amount_usd NUMERIC(12,2), budget_factor NUMERIC(6,4), reason TEXT,
     processed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (creator_id, payout_at))`,
  'CREATE INDEX IF NOT EXISTS payout_cycles_due ON payout_cycles (status, payout_at)',
  // Contrôle des vues : appareil (identifiant aléatoire gardé par le téléphone) et réseau, jamais en clair.
  'ALTER TABLE content_view_log ADD COLUMN IF NOT EXISTS device_key TEXT',
  'ALTER TABLE content_view_log ADD COLUMN IF NOT EXISTS net_key TEXT',
  'CREATE INDEX IF NOT EXISTS content_view_log_device ON content_view_log (device_key)',
  `CREATE TABLE IF NOT EXISTS device_links (
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     device_key TEXT NOT NULL,
     first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (creator_id, device_key))`,
  'CREATE INDEX IF NOT EXISTS device_links_device ON device_links (device_key)',
  'ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS fake_views INTEGER',
  'ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS duplicates INTEGER',
  `CREATE TABLE IF NOT EXISTS creator_warnings (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     kind TEXT NOT NULL DEFAULT 'fausses_vues',
     cycle_id UUID,
     level INTEGER NOT NULL DEFAULT 1,
     fake_views INTEGER NOT NULL DEFAULT 0,
     total_views INTEGER NOT NULL DEFAULT 0,
     details JSONB,
     message TEXT NOT NULL,
     read_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS creator_warnings_creator ON creator_warnings (creator_id, created_at DESC)',
];

// Identifiant d'appareil envoyé par l'application (en-tête X-Eaji-Device) et empreinte du réseau, chiffrés.
// Les appareils utilisés par chaque compte connecté sont notés (une fois par jour) pour repérer les fausses vues.
function deviceTracker({ db, verifySessionToken }) {
  const seen = new Map();
  return (req, res, next) => {
    const raw = String(req.headers['x-eaji-device'] || '');
    req.deviceKey = DEVICE_RE.test(raw) ? 'd:' + sha(`eaji-appareil:${raw}`) : null;
    req.netKey = sha(`eaji-reseau:${req.ip || ''}`);
    const token = String(req.headers.authorization || '').replace('Bearer ', '');
    if (req.deviceKey && token && verifySessionToken) {
      let id = null;
      try { id = verifySessionToken(token); } catch { id = null; }
      if (id && UUID_RE.test(String(id))) {
        const key = `${id}|${req.deviceKey}`, today = new Date().toISOString().slice(0, 10);
        if (seen.get(key) !== today) {
          if (seen.size > 50000) seen.clear();
          seen.set(key, today);
          const d = typeof db === 'function' ? db() : db;
          if (d) d.query(`INSERT INTO device_links (creator_id, device_key) VALUES ($1, $2)
                          ON CONFLICT (creator_id, device_key) DO UPDATE SET last_seen = now()`, [id, req.deviceKey]).catch(() => {});
        }
      }
    }
    next();
  };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function register({ app, db, requireAuth, requireAdminPrincipal, notify, notifyAdmins = async () => {}, isMonetizedCreator, calculateMonthlyPayout }) {
  // ---------- Périodes Premium d'un créateur ----------
  // Abonnements Premium mis bout à bout (un renouvellement commence à la fin du précédent) = une « chaîne ».
  async function premiumChains(creatorId) {
    const subs = await db.all(
      "SELECT starts_at, ends_at FROM premium_subscriptions WHERE creator_id = $1 AND plan LIKE 'premium%' ORDER BY starts_at", [creatorId]);
    const chains = [];
    for (const s of subs) {
      const st = new Date(s.starts_at).getTime(), en = new Date(s.ends_at).getTime();
      const last = chains[chains.length - 1];
      if (last && st <= last.end + 60000) { last.subs.push({ st, en }); last.end = Math.max(last.end, en); }
      else chains.push({ start: st, end: en, subs: [{ st, en }] });
    }
    return chains;
  }
  // Début de la chaîne Premium en cours (null si le créateur n'est pas Premium maintenant).
  async function currentChainStart(creatorId) {
    const now = Date.now();
    const c = (await premiumChains(creatorId)).find((x) => x.start <= now && x.end > now);
    return c ? c.start : null;
  }
  // Même jour, N mois plus tard (le 31 janvier + 1 mois = le 28 ou 29 février), en temps universel.
  function addMonths(ts, n) {
    const d = new Date(ts);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }
  // Crée les périodes manquantes : chaque abonnement est découpé en mois, à partir du jour d'activation
  // (activé le 10 octobre → périodes du 10 au 10). Le versement a lieu 5 jours avant la fin de chaque mois
  // (le 25e jour pour un mois de 30 jours). Une publication appartient à la période dont le versement suit
  // sa mise en ligne (fenêtre = du versement précédent à celui-ci).
  async function ensureCycles(creatorId) {
    for (const chain of await premiumChains(creatorId)) {
      let windowStart = chain.start;
      for (const sub of chain.subs) {
        for (let k = 0; k < 240; k++) {
          const cycleStart = addMonths(sub.st, k);
          const payoutAt = addMonths(sub.st, k + 1) - DAYS_BEFORE_END * DAY;
          if (payoutAt > sub.en) break;
          await db.query(
            `INSERT INTO payout_cycles (creator_id, window_start, cycle_start, payout_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (creator_id, payout_at) DO NOTHING`,
            [creatorId, new Date(windowStart).toISOString(), new Date(cycleStart).toISOString(), new Date(payoutAt).toISOString()]);
          windowStart = payoutAt;
        }
      }
    }
  }

  // ---------- Part du créateur sur une vente ou un cadeau (règle interne) ----------
  // Renvoie { rate, source } : rate = part du créateur (0 = tout pour Eaji).
  async function creatorShareFor(contentId) {
    const c = await db.query('SELECT id, creator_id, created_at, monetized_at, duplicate_of FROM content_items WHERE id = $1', [contentId]);
    if (!c) return { rate: SHARE_NEW, tag: '' };
    if (c.duplicate_of) return { rate: 0, tag: '_doublon' };
    const chainStart = await currentChainStart(c.creator_id);
    if (!c.monetized_at && chainStart && new Date(c.created_at).getTime() >= chainStart) return { rate: SHARE_NEW, tag: '' };
    return { rate: SHARE_OLD, tag: '_ancien' };
  }

  // ---------- Budget : jamais plus que le pourcentage choisi des revenus d'Eaji des 30 derniers jours ----------
  async function budgetPercent() {
    const r = await db.query("SELECT value FROM app_settings WHERE key = 'payout_budget_percent'");
    const v = r ? Number(r.value) : 30;
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 30;
  }
  async function budgetNow() {
    const percent = await budgetPercent();
    const rev = await db.query(
      "SELECT COALESCE(SUM(amount_usd), 0)::float AS t FROM revenue_ledger WHERE beneficiary = 'eaji' AND created_at > now() - interval '30 days'");
    const used = await db.query(
      "SELECT COALESCE(SUM(amount_usd), 0)::float AS t FROM payout_cycles WHERE status = 'paye' AND processed_at > now() - interval '30 days'");
    const budget = round2(rev.t * percent / 100);
    return { percent, revenue: round2(rev.t), budget, used: round2(used.t), remaining: Math.max(0, round2(budget - used.t)) };
  }

  // Publications d'une fenêtre qui comptent (ni IA, ni doublon, pas encore rémunérées).
  const WINDOW_CONTENTS = `SELECT id FROM content_items WHERE creator_id = $1 AND created_at > $2 AND created_at <= $3
      AND monetized_at IS NULL AND NOT ai_generated AND duplicate_of IS NULL AND status <> 'retire'`;
  async function windowViews(creatorId, from, to) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM content_view_log v
       WHERE v.content_id IN (${WINDOW_CONTENTS}) AND v.day <= ($3::timestamptz)::date`, [creatorId, from, to]);
    return r ? r.n : 0;
  }
  async function creatorStats(creatorId) {
    return db.query(
      `SELECT c.country_code, c.phone, c.account_status,
              GREATEST(COALESCE((SELECT subscriber_count FROM subscriber_counts WHERE creator_id = c.id ORDER BY verified_at DESC LIMIT 1), 0),
                       (SELECT COUNT(*)::int FROM follows WHERE followed_id = c.id)) AS subscribers,
              (SELECT COALESCE(SUM(view_count), 0)::int FROM content_items WHERE creator_id = c.id AND NOT ai_generated AND duplicate_of IS NULL) AS views
       FROM creators c WHERE c.id = $1`, [creatorId]);
  }

  // ---------- Contrôle des fausses vues (vues des publications de la fenêtre) ----------
  //  • createur        : vue venant d'un téléphone du créateur, ou d'un compte qui utilise un de ses téléphones ;
  //  • appareil_comptes: compte utilisé sur un téléphone où au moins 4 comptes regardent ce créateur (comptes en série) ;
  //  • meme_appareil   : plusieurs comptes (ou visiteurs) sur un même téléphone, même publication, même jour → une seule vue.
  const AUDIT = `
    WITH v AS (
      SELECT l.content_id, l.viewer_key, l.day, l.device_key FROM content_view_log l
      WHERE l.content_id IN (${WINDOW_CONTENTS}) AND l.day <= ($3::timestamptz)::date),
    own AS (SELECT device_key FROM device_links WHERE creator_id = $1),
    viewers AS (SELECT DISTINCT substr(viewer_key, 3) AS cid FROM v WHERE viewer_key LIKE 'u:%'),
    farm AS (SELECT d.device_key FROM device_links d JOIN viewers w ON w.cid = d.creator_id::text
             GROUP BY d.device_key HAVING COUNT(DISTINCT d.creator_id) >= ${FARM_ACCOUNTS}),
    f AS (
      SELECT v.day,
        CASE
          WHEN v.device_key IN (SELECT device_key FROM own)
            OR (v.viewer_key LIKE 'u:%' AND EXISTS (SELECT 1 FROM device_links d JOIN own o ON o.device_key = d.device_key
                                                    WHERE d.creator_id::text = substr(v.viewer_key, 3)))
            THEN 'createur'
          WHEN v.viewer_key LIKE 'u:%' AND EXISTS (SELECT 1 FROM device_links d JOIN farm fa ON fa.device_key = d.device_key
                                                   WHERE d.creator_id::text = substr(v.viewer_key, 3))
            THEN 'appareil_comptes'
          WHEN v.device_key IS NOT NULL AND ROW_NUMBER() OVER (PARTITION BY v.content_id, v.day, v.device_key ORDER BY v.viewer_key) > 1
            THEN 'meme_appareil'
        END AS rule
      FROM v)`;
  const AUDIT_COLS = `COUNT(*)::int AS total, COUNT(rule)::int AS fake,
      COUNT(*) FILTER (WHERE rule = 'createur')::int AS createur,
      COUNT(*) FILTER (WHERE rule = 'appareil_comptes')::int AS appareil_comptes,
      COUNT(*) FILTER (WHERE rule = 'meme_appareil')::int AS meme_appareil`;
  async function auditViews(creatorId, from, to) {
    const r = await db.query(`${AUDIT} SELECT ${AUDIT_COLS} FROM f`, [creatorId, from, to]);
    return r || { total: 0, fake: 0, createur: 0, appareil_comptes: 0, meme_appareil: 0 };
  }
  async function auditByDay(creatorId, from, to) {
    return db.all(`${AUDIT} SELECT to_char(day, 'YYYY-MM-DD') AS day, ${AUDIT_COLS} FROM f GROUP BY day ORDER BY day`, [creatorId, from, to]);
  }
  async function windowDuplicates(creatorId, from, to) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM content_items WHERE creator_id = $1 AND created_at > $2 AND created_at <= $3
         AND duplicate_of IS NOT NULL AND monetized_at IS NULL`, [creatorId, from, to]);
    return r ? r.n : 0;
  }
  const shouldWarn = (a) => a.fake >= WARN_ALWAYS || (a.fake >= WARN_MIN && a.fake >= a.total * WARN_RATIO);

  // Mise en garde automatique (1re fois), puis avertissement (2e), puis dernier avertissement (3e et plus,
  // l'équipe d'Eaji est alors prévenue et peut suspendre le compte).
  async function warnFakeViews(creatorId, cycleId, a, duplicates) {
    const prev = await db.query("SELECT COUNT(*)::int AS n FROM creator_warnings WHERE creator_id = $1 AND kind = 'fausses_vues'", [creatorId]);
    const level = (prev ? prev.n : 0) + 1;
    const why = [];
    if (a.createur) why.push('des vues venant de ton propre téléphone ou de tes autres comptes');
    if (a.meme_appareil) why.push('plusieurs comptes qui regardent depuis un même téléphone');
    if (a.appareil_comptes) why.push('des comptes créés en série sur un même téléphone');
    const head = level === 1 ? '⚠️ Mise en garde' : level === 2 ? '⚠️ Avertissement (2e)' : `⛔ Dernier avertissement (${level}e)`;
    const tail = level === 1 ? 'Seules les vues de vraies personnes sont payées.'
      : level === 2 ? 'Si cela continue, ton compte pourra être suspendu.'
      : "L'équipe d'Eaji a été prévenue : ton compte peut être suspendu à tout moment.";
    const copies = duplicates > 0 ? ` ${duplicates} copie(s) d'un contenu déjà publié n'ont pas été comptées.` : '';
    const message = `${head} : ${a.fake} fausse(s) vue(s) ont été retirées de ta rémunération (${why.join(', ') || 'vues non valables'}). ${tail}${copies}`;
    await db.query(
      `INSERT INTO creator_warnings (creator_id, kind, cycle_id, level, fake_views, total_views, details, message)
       VALUES ($1, 'fausses_vues', $2, $3, $4, $5, $6, $7)`,
      [creatorId, cycleId, level, a.fake, a.total,
       JSON.stringify({ createur: a.createur, appareil_comptes: a.appareil_comptes, meme_appareil: a.meme_appareil, copies: duplicates }), message]);
    await notify(creatorId, 'avertissement', message, 's-paiements', { title: head });
    if (level >= 3) {
      const c = await db.query('SELECT name FROM creators WHERE id = $1', [creatorId]);
      notifyAdmins({ title: '⛔ Fausses vues répétées', body: `${c ? c.name : 'Un créateur'} : ${level}e avertissement (${a.fake} fausses vues retirées). Tu peux suspendre le compte.`,
        link: 'admin:v-payouts', kind: 'securite', permission: 'gerer_comptes_utilisateurs' });
    }
    return level;
  }

  // ---------- Traitement d'une période arrivée à son 25e jour ----------
  async function processCycle(cy) {
    const claimed = await db.query("UPDATE payout_cycles SET status = 'sans_gain', processed_at = now() WHERE id = $1 AND status = 'en_cours' RETURNING id", [cy.id]);
    if (!claimed) return null; // déjà traitée
    const from = new Date(cy.window_start).toISOString(), to = new Date(cy.payout_at).toISOString();
    const ids = (await db.all(WINDOW_CONTENTS, [cy.creator_id, from, to])).map((r) => r.id);
    // Contrôle : les fausses vues sont retirées avant tout calcul (règle des 70 % comprise).
    const audit = await auditViews(cy.creator_id, from, to);
    const views = Math.max(0, audit.total - audit.fake);
    const duplicates = await windowDuplicates(cy.creator_id, from, to);
    const s = await creatorStats(cy.creator_id);
    let reason = null, base = 0, paidSubs = 0, amount = 0, factor = 1;
    if (!s || s.account_status !== 'actif') reason = 'compte inactif';
    else if (!isMonetizedCreator(s.country_code, s.phone)) reason = 'pays non monétisé';
    else if (!ids.length) reason = 'aucune nouvelle publication';
    else {
      const p = calculateMonthlyPayout({ subscribers: Number(s.subscribers), views: Math.max(0, Number(s.views) - audit.fake), monthlyViews: views, currency: 'USD' });
      paidSubs = p.paidSubscribers || 0;
      if (!p.eligible) reason = 'moins de 1 000 abonnés ou 1 000 vues';
      else {
        base = p.amount;
        const b = await budgetNow();
        amount = Math.floor(Math.min(base, b.remaining) * 100) / 100;
        factor = base > 0 ? amount / base : 1;
        if (!(amount > 0)) reason = base > 0 ? 'budget épuisé' : 'vues insuffisantes';
      }
    }
    // Les publications de la période ont eu leur rémunération : elles ne compteront plus jamais.
    if (ids.length) await db.query('UPDATE content_items SET monetized_at = $2, payout_cycle_id = $3 WHERE id = ANY($1::uuid[])', [ids, to, cy.id]);
    await db.query(
      `UPDATE payout_cycles SET status = $2, contents = $3, cycle_views = $4, subscribers = $5, paid_subscribers = $6,
         base_amount_usd = $7, amount_usd = $8, budget_factor = $9, reason = $10, fake_views = $11, duplicates = $12 WHERE id = $1`,
      [cy.id, amount > 0 ? 'paye' : 'sans_gain', ids.length, views, s ? Number(s.subscribers) : 0, paidSubs, base, amount,
       Math.round(factor * 10000) / 10000, reason, audit.fake, duplicates]);
    if (amount > 0) {
      await db.query("INSERT INTO revenue_ledger (beneficiary, creator_id, source, amount_usd) VALUES ('createur', $1, 'remuneration', $2)", [cy.creator_id, amount]);
      await notify(cy.creator_id, 'remuneration', `💰 Tes gains en attente (vues et abonnés) sont vérifiés : ${amount.toFixed(2)} $ sont maintenant disponibles. Tu peux les retirer, t'abonner ou offrir des cadeaux.`, 's-paiements');
    }
    let warning = null;
    if (shouldWarn(audit)) warning = await warnFakeViews(cy.creator_id, cy.id, audit, duplicates).catch((e) => { console.error('[Eaji] Mise en garde non envoyée :', e.message); return null; });
    return { amount, reason, fakeViews: audit.fake, warningLevel: warning };
  }
  async function runDue() {
    const creators = await db.all(
      "SELECT DISTINCT creator_id FROM premium_subscriptions WHERE plan LIKE 'premium%' AND ends_at > now() - interval '40 days'");
    for (const c of creators) await ensureCycles(c.creator_id).catch(() => {});
    const due = await db.all("SELECT * FROM payout_cycles WHERE status = 'en_cours' AND payout_at <= now() ORDER BY payout_at LIMIT 500");
    let paid = 0;
    for (const cy of due) { const r = await processCycle(cy).catch((e) => { console.error('[Eaji] Période non traitée :', e.message); return null; }); if (r && r.amount > 0) paid++; }
    return { processed: due.length, paid };
  }
  if (process.env.NODE_ENV !== 'test') {
    setTimeout(() => runDue().catch(() => {}), 20000).unref();
    setInterval(() => runDue().catch(() => {}), 30 * 60 * 1000).unref();
  }

  // ---------- Estimation affichée au créateur (sans dévoiler la règle) ----------
  async function currentWindow(creatorId) {
    await ensureCycles(creatorId);
    const cy = await db.query(
      "SELECT * FROM payout_cycles WHERE creator_id = $1 AND status = 'en_cours' ORDER BY payout_at LIMIT 1", [creatorId]);
    if (!cy) return null;
    return { from: new Date(cy.window_start).toISOString(), to: new Date(Math.min(Date.now(), new Date(cy.payout_at).getTime())).toISOString() };
  }
  async function currentPeriodViews(creatorId) {
    const w = await currentWindow(creatorId);
    if (!w) return 0;
    const a = await auditViews(creatorId, w.from, w.to);
    return Math.max(0, a.total - a.fake);
  }

  // Gains « en attente » (vues et abonnés) de la période en cours, jour après jour : ce que le créateur
  // recevrait si le versement avait lieu ce soir-là. Ils ne sont ni retirables ni utilisables avant le
  // versement ; les fausses vues déjà repérées sont retirées, sans le dire (le détail vient au versement).
  async function pendingOf(creatorId) {
    await ensureCycles(creatorId);
    const cy = await db.query(
      "SELECT * FROM payout_cycles WHERE creator_id = $1 AND status = 'en_cours' AND window_start <= now() ORDER BY payout_at LIMIT 1", [creatorId]);
    if (!cy) return null;
    const from = new Date(cy.window_start).toISOString();
    const to = new Date(Math.min(Date.now(), new Date(cy.payout_at).getTime())).toISOString();
    const out = { amount: 0, daily: [], payoutAt: new Date(cy.payout_at).toISOString() };
    const s = await creatorStats(creatorId);
    if (!s || s.account_status !== 'actif' || !isMonetizedCreator(s.country_code, s.phone)) return out;
    const n = await db.query(`SELECT COUNT(*)::int AS n FROM (${WINDOW_CONTENTS}) x`, [creatorId, from, to]);
    if (!n || !n.n) return out;
    const days = await auditByDay(creatorId, from, to);
    const fakeAll = days.reduce((t, d) => t + d.fake, 0);
    const budget = await budgetNow();
    let cum = 0, prev = 0;
    for (const d of days) {
      cum += Math.max(0, d.total - d.fake);
      const p = calculateMonthlyPayout({ subscribers: Number(s.subscribers), views: Math.max(0, Number(s.views) - fakeAll), monthlyViews: cum, currency: 'USD' });
      const amt = p.eligible ? Math.floor(Math.min(p.amount, budget.remaining) * 100) / 100 : 0;
      const inc = round2(amt - prev);
      if (inc > 0) out.daily.push({ day: d.day, amount: inc });
      prev = Math.max(prev, amt);
    }
    out.amount = round2(prev);
    out.daily.reverse();
    return out;
  }

  // Mises en garde d'un créateur (les plus récentes d'abord).
  async function warningsOf(creatorId, limit = 5) {
    return db.all(
      `SELECT id, level, fake_views, message, created_at, read_at FROM creator_warnings WHERE creator_id = $1
       ORDER BY created_at DESC LIMIT $2`, [creatorId, limit]);
  }
  if (requireAuth) {
    app.get('/api/warnings', requireAuth, async (req, res) => res.json({ warnings: await warningsOf(req.creatorId, 20) }));
    app.post('/api/warnings/read', requireAuth, async (req, res) => {
      await db.query('UPDATE creator_warnings SET read_at = now() WHERE creator_id = $1 AND read_at IS NULL', [req.creatorId]);
      res.json({ ok: true });
    });
  }

  // ---------- Contenus répétés (même fichier ou même lien déjà publié) ----------
  const FP_RE = /^[a-f0-9]{64}$/;
  async function markDuplicate(contentId, { fingerprint, sourceFingerprint, importedFrom }) {
    const fp = FP_RE.test(String(fingerprint || '')) ? fingerprint : null;
    const sfp = FP_RE.test(String(sourceFingerprint || '')) ? sourceFingerprint : null;
    if (fp || sfp) await db.query('UPDATE content_items SET file_fingerprint = $2, source_fingerprint = $3 WHERE id = $1', [contentId, fp, sfp]);
    const prints = [fp, sfp].filter(Boolean);
    let orig = null;
    if (prints.length) {
      orig = await db.query(
        `SELECT id FROM content_items WHERE id <> $1 AND (file_fingerprint = ANY($2::text[]) OR source_fingerprint = ANY($2::text[]))
         ORDER BY created_at LIMIT 1`, [contentId, prints]);
    }
    if (!orig && importedFrom) {
      orig = await db.query('SELECT id FROM content_items WHERE id <> $1 AND imported_from = $2 ORDER BY created_at LIMIT 1', [contentId, importedFrom]);
    }
    if (orig) await db.query('UPDATE content_items SET duplicate_of = $2 WHERE id = $1', [contentId, orig.id]);
    return orig ? orig.id : null;
  }

  // ---------- Administration (administrateur principal) ----------
  app.get('/api/admin/cycles', requireAdminPrincipal, async (req, res) => {
    const items = await db.all(
      `SELECT p.id, p.window_start, p.cycle_start, p.payout_at, p.status, p.contents, p.cycle_views, p.subscribers, p.paid_subscribers,
              p.base_amount_usd, p.amount_usd, p.budget_factor, p.reason, p.processed_at, p.fake_views, p.duplicates, cr.name, cr.country_code
       FROM payout_cycles p JOIN creators cr ON cr.id = p.creator_id
       WHERE p.status <> 'en_cours' OR p.payout_at < now() + interval '7 days'
       ORDER BY CASE WHEN p.status = 'en_cours' THEN 0 ELSE 1 END, COALESCE(p.processed_at, p.payout_at) DESC LIMIT 300`);
    const totals = await db.query(
      `SELECT COALESCE((SELECT SUM(amount_usd) FROM payout_cycles WHERE status = 'paye'), 0)::float AS all_time,
              (SELECT COUNT(*)::int FROM payout_cycles WHERE status = 'en_cours') AS open,
              (SELECT COUNT(*)::int FROM content_view_log v JOIN content_items c ON c.id = v.content_id
                 WHERE (c.monetized_at IS NOT NULL OR c.duplicate_of IS NOT NULL) AND v.day > CURRENT_DATE - 30) AS old_views,
              COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'eaji' AND (source LIKE '%\\_ancien' ESCAPE '\\' OR source LIKE '%\\_doublon' ESCAPE '\\')), 0)::float AS old_money,
              (SELECT COUNT(*)::int FROM content_items WHERE duplicate_of IS NOT NULL) AS duplicates,
              COALESCE((SELECT SUM(fake_views) FROM payout_cycles WHERE status <> 'en_cours'), 0)::int AS fake_views,
              (SELECT COUNT(*)::int FROM creator_warnings) AS warnings`);
    res.json({ items, budget: await budgetNow(), ...totals });
  });
  app.post('/api/admin/cycles/run', requireAdminPrincipal, async (req, res) => res.json(await runDue()));
  app.get('/api/admin/warnings', requireAdminPrincipal, async (req, res) => {
    const rows = await db.all(
      `SELECT w.id, w.level, w.fake_views, w.total_views, w.details, w.message, w.created_at, w.read_at,
              cr.id AS creator_id, cr.name, cr.country_code, cr.account_status
       FROM creator_warnings w JOIN creators cr ON cr.id = w.creator_id ORDER BY w.created_at DESC LIMIT 200`);
    res.json({ warnings: rows });
  });
  app.get('/api/admin/duplicates', requireAdminPrincipal, async (req, res) => {
    const rows = await db.all(
      `SELECT d.id, d.title, d.created_at, d.content_type, cr.id AS creator_id, cr.name AS creator_name,
              o.id AS original_id, o.title AS original_title, o.created_at AS original_at, oc.name AS original_creator
       FROM content_items d JOIN content_items o ON o.id = d.duplicate_of
       JOIN creators cr ON cr.id = d.creator_id JOIN creators oc ON oc.id = o.creator_id
       ORDER BY d.created_at DESC LIMIT 200`);
    res.json({ duplicates: rows });
  });

  // Date du prochain versement de la période en cours (affichée au créateur, sans la règle).
  async function nextPayoutAt(creatorId) {
    await ensureCycles(creatorId);
    const cy = await db.query("SELECT payout_at FROM payout_cycles WHERE creator_id = $1 AND status = 'en_cours' ORDER BY payout_at LIMIT 1", [creatorId]);
    return cy ? new Date(cy.payout_at).toISOString() : null;
  }

  return { creatorShareFor, currentPeriodViews, pendingOf, warningsOf, auditViews, markDuplicate, runDue, ensureCycles, nextPayoutAt, SHARE_NEW, SHARE_OLD };
}

module.exports = { MIGRATIONS, register, deviceTracker };
