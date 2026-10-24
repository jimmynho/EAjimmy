// Eaji — vérification d'identité (avant tout retrait d'argent).
// Le créateur envoie : nom complet comme sur sa pièce d'identité, type et numéro de la pièce,
// date de naissance, adresse complète, ville, photo de la pièce (recto, verso si besoin) et une
// photo de son visage prise en direct avec la caméra. L'administrateur compare et valide.
// Les photos restent privées : seules les personnes de l'administration peuvent les ouvrir.

const ID_TYPES = {
  carte_identite: "Carte d'identité nationale",
  carte_electeur: "Carte d'électeur",
  passeport: 'Passeport',
  permis: 'Permis de conduire',
};

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS identity_verifications (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     full_name TEXT NOT NULL,
     id_type TEXT NOT NULL,
     id_number TEXT NOT NULL,
     birth_date DATE NOT NULL,
     address TEXT NOT NULL,
     city TEXT NOT NULL,
     country_code TEXT NOT NULL,
     id_front_key TEXT NOT NULL,
     id_back_key TEXT,
     selfie_key TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente', 'verifie', 'rejete')),
     admin_note TEXT,
     admin_id UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     reviewed_at TIMESTAMPTZ)`,
  'CREATE INDEX IF NOT EXISTS identity_creator_idx ON identity_verifications (creator_id, created_at DESC)',
];

function register({ app, db, requireAuth, requireAdminPermission, createDownloadUrl, isKnownCountry, notify }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const own = (creatorId, key) => key && String(key).startsWith(`${creatorId}/`) && !String(key).includes('..');

  async function latest(creatorId) {
    return db.query('SELECT * FROM identity_verifications WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1', [creatorId]);
  }
  async function isVerified(creatorId) {
    const v = await latest(creatorId);
    return Boolean(v && v.status === 'verifie');
  }

  app.get('/api/identity', requireAuth, async (req, res) => {
    const v = await latest(req.creatorId);
    res.json({
      status: v ? v.status : 'aucune',
      fullName: v ? v.full_name : null,
      adminNote: v && v.status === 'rejete' ? v.admin_note : null,
      submittedAt: v ? v.created_at : null,
      idTypes: ID_TYPES,
    });
  });

  app.post('/api/identity', requireAuth, async (req, res) => {
    const b = req.body;
    const fullName = String(b.fullName || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const idNumber = String(b.idNumber || '').trim().slice(0, 40);
    const address = String(b.address || '').trim().slice(0, 300);
    const city = String(b.city || '').trim().slice(0, 80);
    const countryCode = String(b.countryCode || '').toUpperCase();
    const birth = new Date(String(b.birthDate || ''));
    if (fullName.split(' ').length < 2) return res.status(400).json({ error: 'Écris ton nom complet (au moins nom et prénom), exactement comme sur ta pièce.' });
    if (!ID_TYPES[b.idType]) return res.status(400).json({ error: "Choisis le type de pièce d'identité." });
    if (idNumber.length < 4) return res.status(400).json({ error: 'Numéro de pièce invalide.' });
    if (Number.isNaN(birth.getTime())) return res.status(400).json({ error: 'Date de naissance invalide.' });
    const age = (Date.now() - birth.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 18 || age > 110) return res.status(400).json({ error: 'Il faut avoir au moins 18 ans pour retirer de l\'argent.' });
    if (address.length < 8) return res.status(400).json({ error: 'Écris ton adresse complète (numéro, avenue, quartier, commune).' });
    if (city.length < 2) return res.status(400).json({ error: 'Indique ta ville.' });
    if (!isKnownCountry(countryCode)) return res.status(400).json({ error: 'Choisis ton pays.' });
    if (!own(req.creatorId, b.idFrontKey)) return res.status(400).json({ error: "Ajoute la photo de ta pièce d'identité (recto)." });
    if (b.idBackKey && !own(req.creatorId, b.idBackKey)) return res.status(403).json({ error: 'Fichier non autorisé.' });
    if (!own(req.creatorId, b.selfieKey)) return res.status(400).json({ error: 'Prends la photo de ton visage avec la caméra.' });
    const current = await latest(req.creatorId);
    if (current && current.status === 'en_attente') return res.status(409).json({ error: 'Ta demande est déjà en cours de vérification.' });
    if (current && current.status === 'verifie') return res.status(409).json({ error: 'Ton identité est déjà vérifiée.' });
    const v = await db.query(
      `INSERT INTO identity_verifications (creator_id, full_name, id_type, id_number, birth_date, address, city, country_code, id_front_key, id_back_key, selfie_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [req.creatorId, fullName, b.idType, idNumber, birth.toISOString().slice(0, 10), address, city, countryCode, b.idFrontKey, b.idBackKey || null, b.selfieKey]);
    res.status(201).json({ verificationId: v.id, status: 'en_attente' });
  });

  // ---------- Administration ----------
  app.get('/api/admin/identities', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
    const status = ['en_attente', 'verifie', 'rejete'].includes(req.query.status) ? req.query.status : 'en_attente';
    const rows = await db.all(
      `SELECT v.*, cr.name AS account_name, cr.email, cr.phone, cr.country_code AS account_country
       FROM identity_verifications v JOIN creators cr ON cr.id = v.creator_id
       WHERE v.status = $1 ORDER BY v.created_at ASC LIMIT 100`, [status]);
    for (const r of rows) {
      r.idFrontUrl = await createDownloadUrl(r.id_front_key).catch(() => null);
      r.idBackUrl = r.id_back_key ? await createDownloadUrl(r.id_back_key).catch(() => null) : null;
      r.selfieUrl = await createDownloadUrl(r.selfie_key).catch(() => null);
      r.idTypeLabel = ID_TYPES[r.id_type] || r.id_type;
      delete r.id_front_key; delete r.id_back_key; delete r.selfie_key;
    }
    res.json({ identities: rows });
  });

  app.post('/api/admin/identities/:id/approve', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const v = await db.query(
      `UPDATE identity_verifications SET status = 'verifie', reviewed_at = now(), admin_id = $2
       WHERE id = $1 AND status = 'en_attente' RETURNING creator_id, full_name`, [req.params.id, req.adminId]);
    if (!v) return res.status(404).json({ error: 'Demande introuvable ou déjà traitée.' });
    // Le nom du compte devient celui de la pièce d'identité.
    await db.query("UPDATE creators SET name = $1, verification_status = 'verifie' WHERE id = $2", [v.full_name, v.creator_id]);
    await notify(v.creator_id, 'identite', '✅ Ton identité est vérifiée : tu peux maintenant retirer ton argent.', 's-paiements');
    res.json({ approved: true });
  });

  app.post('/api/admin/identities/:id/reject', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const note = String(req.body.note || '').trim().slice(0, 300) || 'Documents illisibles ou non conformes.';
    const v = await db.query(
      `UPDATE identity_verifications SET status = 'rejete', reviewed_at = now(), admin_id = $2, admin_note = $3
       WHERE id = $1 AND status = 'en_attente' RETURNING creator_id`, [req.params.id, req.adminId, note]);
    if (!v) return res.status(404).json({ error: 'Demande introuvable ou déjà traitée.' });
    await db.query("UPDATE creators SET verification_status = 'rejete' WHERE id = $1", [v.creator_id]);
    await notify(v.creator_id, 'identite', `❌ Vérification d'identité refusée : ${note} Tu peux renvoyer tes documents.`, 's-paiements');
    res.json({ rejected: true });
  });

  return { isVerified };
}

module.exports = { register, MIGRATIONS, ID_TYPES };
