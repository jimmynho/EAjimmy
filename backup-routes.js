// Eaji — sauvegarde complète de la base de données, depuis le tableau d'administration.
//  • « Télécharger une copie complète » : toutes les tables (comptes, publications, gains, paiements…)
//    dans un seul fichier compressé (.jsonl.gz), à garder en lieu sûr.
//  • « Remettre une sauvegarde » : recharge ce fichier dans une base NEUVE (par exemple chez un nouvel
//    hébergeur). Refusé si la base contient déjà des comptes, pour ne jamais écraser de vraies données.
// Réservé à l'administrateur principal, avec son mot de passe. Les fichiers (vidéos, photos) restent chez
// Backblaze : ils ne sont pas dans la sauvegarde et n'en ont pas besoin.
const zlib = require('zlib');
const readline = require('readline');

const VERSION = 1;
const BATCH = 500;
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 Go compressé au plus

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const TABLES_SQL = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name";

function register({ app, db, pool, bcrypt, requireAdminPrincipal, rateLimit }) {
  async function passwordOk(adminId, password) {
    const a = await db.query('SELECT password_hash FROM admins WHERE id = $1', [adminId]);
    return Boolean(a && a.password_hash && password && await bcrypt.compare(String(password), a.password_hash));
  }

  // ---------- Télécharger une copie complète ----------
  app.post('/api/admin/backup', requireAdminPrincipal, rateLimit('backup', 12, 60 * 60 * 1000, 'Trop de sauvegardes demandées. Réessaie dans une heure.'), async (req, res) => {
    if (!(await passwordOk(req.adminId, req.body && req.body.password))) return res.status(403).json({ error: 'Mot de passe administrateur incorrect.' });
    const client = await pool.connect();
    const gz = zlib.createGzip({ level: 6 });
    let started = false;
    const counts = {};
    try {
      // Une « photo » figée de la base : même si des utilisateurs publient pendant la copie, tout reste cohérent.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tables = (await client.query(TABLES_SQL)).rows.map((x) => x.table_name);
      const day = new Date().toISOString().slice(0, 10);
      res.status(200).set({
        'Content-Type': 'application/gzip', 'Cache-Control': 'no-store', 'Access-Control-Expose-Headers': 'Content-Disposition',
        'Content-Disposition': `attachment; filename="eaji-sauvegarde-${day}.jsonl.gz"`,
      });
      gz.pipe(res);
      started = true;
      const write = (o) => new Promise((ok) => { if (gz.write(JSON.stringify(o) + '\n')) ok(); else gz.once('drain', ok); });
      await write({ eaji_backup: VERSION, created_at: new Date().toISOString(), tables });
      for (const t of tables) {
        counts[t] = 0;
        // Postgres transforme lui-même chaque ligne en JSON (dates, montants, fichiers binaires) : rien ne se perd.
        await client.query(`DECLARE eaji_bk NO SCROLL CURSOR FOR SELECT row_to_json(x) AS j FROM ${ident(t)} x`);
        for (;;) {
          const rows = (await client.query(`FETCH ${BATCH} FROM eaji_bk`)).rows;
          for (const r of rows) await write({ t, r: r.j });
          counts[t] += rows.length;
          if (rows.length < BATCH) break;
        }
        await client.query('CLOSE eaji_bk');
      }
      await write({ end: true, counts });
      await client.query('COMMIT');
      console.log(`[Eaji] Sauvegarde complète téléchargée par l'administrateur principal (${Object.values(counts).reduce((a, b) => a + b, 0)} lignes).`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Eaji] Sauvegarde interrompue :', e.message);
      if (!started) { client.release(); return res.status(500).json({ error: 'Sauvegarde impossible : ' + e.message }); }
      // Le fichier n'aura pas de ligne de fin : « Remettre une sauvegarde » le refusera comme incomplet.
      gz.write(JSON.stringify({ error: 'Sauvegarde interrompue : ' + e.message }) + '\n');
    }
    client.release();
    gz.end();
  });

  // ---------- Remettre une sauvegarde (base neuve seulement) ----------
  app.post('/api/admin/restore', requireAdminPrincipal, rateLimit('restore', 6, 60 * 60 * 1000), async (req, res) => {
    if (!(await passwordOk(req.adminId, req.headers['x-admin-password']))) return res.status(403).json({ error: 'Mot de passe administrateur incorrect.' });
    const used = await db.query('SELECT COUNT(*)::int AS n FROM creators');
    if (used.n > 0) {
      return res.status(409).json({ code: 'base_non_vide', error: `Cette base contient déjà ${used.n} compte(s) : la sauvegarde ne peut être remise que dans une base neuve (pour ne jamais écraser de vraies données).` });
    }
    const client = await pool.connect();
    const counts = {}, skipped = new Set();
    let header = null, endSeen = false;
    try {
      await client.query('BEGIN');
      const target = new Set((await client.query(TABLES_SQL)).rows.map((x) => x.table_name));
      const columns = {};
      for (const t of target) {
        // Les colonnes calculées automatiquement par Postgres ne se remplissent pas à la main.
        columns[t] = new Set((await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'", [t])).rows.map((c) => c.column_name));
      }
      // Les liens entre tables sont retirés le temps du chargement, puis remis tels quels (et revérifiés).
      const fks = (await client.query(
        `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)).rows;
      for (const f of fks) await client.query(`ALTER TABLE ${f.tbl} DROP CONSTRAINT ${ident(f.conname)}`);
      // La base neuve ne contient que l'administrateur créé pour l'occasion : il est remplacé par ceux de la sauvegarde.
      if (target.size) await client.query(`TRUNCATE ${[...target].map(ident).join(', ')}`);

      const pending = new Map();
      const flush = async (t) => {
        const rows = pending.get(t); if (!rows || !rows.length) return;
        pending.set(t, []);
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => columns[t].has(k));
        if (!keys.length) return;
        const cols = keys.map(ident).join(', ');
        await client.query(`INSERT INTO ${ident(t)} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM json_populate_recordset(NULL::${ident(t)}, $1::json)`, [JSON.stringify(rows)]);
        counts[t] = (counts[t] || 0) + rows.length;
      };

      // Lecture du fichier envoyé, ligne par ligne (il n'est jamais chargé en entier en mémoire).
      let size = 0, tooBig = false;
      const gunzip = zlib.createGunzip();
      const fail = (e) => gunzip.destroy(e);
      req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { tooBig = true; fail(new Error('Fichier trop lourd (1 Go au plus).')); } });
      req.on('error', fail);
      req.on('aborted', () => fail(new Error('Envoi du fichier interrompu.')));
      req.pipe(gunzip);
      const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
      const gzError = new Promise((_, ko) => gunzip.on('error', (e) => ko(tooBig ? e : new Error(/header|incorrect|unexpected end/i.test(e.message) ? "Ce fichier n'est pas une sauvegarde Eaji (ou il est abîmé)." : e.message))));
      gzError.catch(() => {});
      const lines = (async () => {
        for await (const line of rl) {
          if (!line.trim()) continue;
          let o;
          try { o = JSON.parse(line); } catch (e) { throw new Error("Ce fichier n'est pas une sauvegarde Eaji (ou il est abîmé)."); }
          if (!header) {
            if (!o || o.eaji_backup !== VERSION) throw new Error("Ce fichier n'est pas une sauvegarde Eaji.");
            header = o; continue;
          }
          if (o.error) throw new Error('cette sauvegarde avait été coupée pendant sa création.');
          if (o.end) { endSeen = true; continue; }
          if (!target.has(o.t)) { skipped.add(o.t); continue; }
          if (!pending.has(o.t)) pending.set(o.t, []);
          pending.get(o.t).push(o.r);
          if (pending.get(o.t).length >= BATCH) await flush(o.t);
        }
      })();
      await Promise.race([lines, gzError]);
      for (const t of pending.keys()) await flush(t);
      if (!header || !endSeen) throw new Error('fichier incomplet (la sauvegarde a été coupée).');

      for (const f of fks) await client.query(`ALTER TABLE ${f.tbl} ADD CONSTRAINT ${ident(f.conname)} ${f.def}`);
      // Les compteurs automatiques (numéros) reprennent après la plus grande valeur.
      const seqs = (await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`)).rows;
      for (const s of seqs) {
        await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${ident(s.column_name)}) FROM ${ident(s.table_name)}), 0) + 1, false)`,
          [`public.${ident(s.table_name)}`, s.column_name]);
      }
      await client.query('COMMIT');
      console.log(`[Eaji] Sauvegarde du ${header.created_at} remise dans la base.`);
      res.json({ restored: true, from: header.created_at, counts, skipped: [...skipped] });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      req.unpipe(); req.resume();
      if (!res.headersSent) res.status(400).json({ error: `Sauvegarde non remise : ${e.message} Rien n'a été changé.` });
    } finally { client.release(); }
  });
}

module.exports = { register };
