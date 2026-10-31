// Eaji — connexion renforcée de l'administrateur principal.
//  • À chaque ouverture du tableau d'administration : mot de passe, puis
//    – soit le code de confirmation envoyé dans SA boîte mail (jamais affiché à l'écran),
//    – soit l'empreinte digitale (ou le visage) de son téléphone, enregistrée à l'avance (WebAuthn / « clé d'accès »).
//  • Les administrateurs secondaires gardent la connexion habituelle.
// L'empreinte ne quitte jamais le téléphone : le téléphone signe seulement un défi, que le serveur vérifie
// avec la clé publique enregistrée.
const crypto = require('crypto');

const MIGRATIONS = [
  'ALTER TABLE admins ADD COLUMN IF NOT EXISTS email TEXT',
  `CREATE TABLE IF NOT EXISTS admin_passkeys (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
     credential_id TEXT NOT NULL UNIQUE,
     public_key JSONB NOT NULL,
     alg INTEGER NOT NULL,
     sign_count BIGINT NOT NULL DEFAULT 0,
     label TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS admin_webauthn_challenges (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
     challenge TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('inscription', 'connexion')),
     origin TEXT,
     used BOOLEAN NOT NULL DEFAULT FALSE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---- Lecture CBOR minimale (ce dont WebAuthn a besoin : nombres, octets, textes, listes, tables) ----
function cborDecode(buf, pos = 0) {
  const ib = buf[pos++]; const major = ib >> 5; let info = ib & 31; let val;
  if (info < 24) val = info;
  else if (info === 24) { val = buf[pos]; pos += 1; }
  else if (info === 25) { val = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { val = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) { val = Number(buf.readBigUInt64BE(pos)); pos += 8; }
  else throw new Error('CBOR non pris en charge');
  if (major === 0) return [val, pos];
  if (major === 1) return [-1 - val, pos];
  if (major === 2) return [buf.subarray(pos, pos + val), pos + val];
  if (major === 3) return [buf.subarray(pos, pos + val).toString('utf8'), pos + val];
  if (major === 4) { const a = []; for (let i = 0; i < val; i++) { const [v, p] = cborDecode(buf, pos); a.push(v); pos = p; } return [a, pos]; }
  if (major === 5) { const m = new Map(); for (let i = 0; i < val; i++) { const [k, p1] = cborDecode(buf, pos); const [v, p2] = cborDecode(buf, p1); m.set(k, v); pos = p2; } return [m, pos]; }
  if (major === 7) return [info === 20 ? false : info === 21 ? true : null, pos];
  throw new Error('CBOR non pris en charge');
}

function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('Données du téléphone invalides.');
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33) };
  if (out.flags & 0x40) {
    let p = 37 + 16; // aaguid
    const len = ad.readUInt16BE(p); p += 2;
    out.credentialId = ad.subarray(p, p + len); p += len;
    const [cose] = cborDecode(ad, p);
    out.cose = cose;
  }
  return out;
}

// Clé COSE → clé publique utilisable par Node (ES256 = empreinte Android / iPhone, RS256 = Windows Hello).
function coseToKey(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) } };
  }
  if (kty === 3 && alg === -257) {
    return { alg, jwk: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) } };
  }
  throw new Error('Type de clé du téléphone non pris en charge.');
}

function register({ app, db, bcrypt, requireAdminPrincipal, trySendEmail, maskEmail, signSessionToken, security, rateLimit, smsConnected, sendSms }) {
  // Adresses autorisées pour l'empreinte : le site (PUBLIC_SITE_URL) + WEBAUTHN_EXTRA_ORIGINS (séparées par des virgules).
  function allowedOrigins() {
    const list = [];
    try { list.push(new URL(process.env.PUBLIC_SITE_URL || 'https://eaji.org').origin); } catch (e) { /* adresse invalide */ }
    for (const o of String(process.env.WEBAUTHN_EXTRA_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      try { list.push(new URL(o).origin); } catch (e) { /* ignorée */ }
    }
    return list;
  }
  function originOf(req) {
    const o = String(req.headers.origin || '');
    return allowedOrigins().includes(o) ? o : null;
  }

  async function newCode(adminId) {
    const code = crypto.randomInt(100000, 999999).toString();
    await db.query(
      "INSERT INTO admin_verifications (admin_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')",
      [adminId, await bcrypt.hash(code, 10)]);
    return code;
  }

  // Après le bon mot de passe de l'administrateur principal : code par email + défi pour l'empreinte.
  async function startPrincipal(admin, req, phone) {
    const out = { adminId: admin.id, principal: true };
    const keys = await db.all('SELECT credential_id FROM admin_passkeys WHERE admin_id = $1', [admin.id]);
    const origin = originOf(req);
    if (keys.length && origin) {
      const challenge = b64u(crypto.randomBytes(32));
      await db.query(
        "INSERT INTO admin_webauthn_challenges (admin_id, challenge, kind, origin, expires_at) VALUES ($1, $2, 'connexion', $3, now() + interval '5 minutes')",
        [admin.id, challenge, origin]);
      out.webauthn = { challenge, rpId: new URL(origin).hostname, allowCredentials: keys.map((k) => k.credential_id), timeout: 60000 };
    }
    const code = await newCode(admin.id);
    if (admin.email) {
      const sent = await trySendEmail(admin.email, 'Eaji Admin — code de connexion',
        `Ton code de connexion au tableau d'administration Eaji : ${code}\n\nIl est valable 10 minutes.\n\nSi ce n'est pas toi qui essaies de te connecter, change tout de suite ton mot de passe administrateur.`);
      if (sent) {
        out.channel = 'email'; out.emailTo = maskEmail(admin.email);
        out.message = `Code envoyé à ${maskEmail(admin.email)}.`;
        return out;
      }
      // Email impossible à envoyer (panne du service d'email) : pour ne jamais bloquer l'administrateur principal,
      // le code passe par SMS si possible, sinon il est affiché — et l'événement est noté comme alerte de sécurité.
      out.emailFailed = true;
      await security.log('admin_email_code_echec', 'alerte', { detail: "Code de connexion de l'administrateur principal : l'email n'a pas pu être envoyé." }).catch(() => {});
    } else {
      out.needsSetup = true;
    }
    if (smsConnected && phone) {
      await sendSms(phone, `Eaji Admin — ton code de vérification : ${code} (valable 10 minutes).`).catch(() => {});
      out.channel = 'sms'; out.message = 'Code envoyé par SMS.';
    } else {
      out.channel = 'ecran'; out.devCode = code;
      out.message = admin.email ? "L'email n'a pas pu être envoyé : voici le code." : 'Code de vérification (ajoute ton email dans Sécurité pour le recevoir par email).';
    }
    return out;
  }

  async function verifyAssertion({ adminId, credential, origin }) {
    if (!credential || !credential.response) throw new Error('Empreinte non reçue.');
    const key = await db.query('SELECT * FROM admin_passkeys WHERE admin_id = $1 AND credential_id = $2', [adminId, String(credential.id || '')]);
    if (!key) throw new Error("Cette empreinte n'est pas enregistrée pour ce compte.");
    const clientDataJSON = fromB64u(credential.response.clientDataJSON);
    const cd = JSON.parse(clientDataJSON.toString('utf8'));
    if (cd.type !== 'webauthn.get') throw new Error('Réponse du téléphone invalide.');
    const ch = await db.query(
      "SELECT * FROM admin_webauthn_challenges WHERE admin_id = $1 AND challenge = $2 AND kind = 'connexion' AND used = FALSE AND expires_at > now()",
      [adminId, String(cd.challenge || '')]);
    if (!ch) throw new Error('Demande expirée : recommence avec ton mot de passe.');
    await db.query('UPDATE admin_webauthn_challenges SET used = TRUE WHERE id = $1', [ch.id]);
    if (cd.origin !== ch.origin || cd.origin !== origin) throw new Error('Adresse du site non reconnue.');
    const authData = fromB64u(credential.response.authenticatorData);
    const ad = parseAuthData(authData);
    if (!ad.rpIdHash.equals(sha256(Buffer.from(new URL(origin).hostname)))) throw new Error('Empreinte faite pour un autre site.');
    if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new Error("L'empreinte (ou le code du téléphone) n'a pas été vérifiée.");
    const pub = crypto.createPublicKey({ key: key.public_key, format: 'jwk' });
    const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
    const ok = crypto.verify('sha256', signed, key.alg === -7 ? { key: pub, dsaEncoding: 'der' } : pub, fromB64u(credential.response.signature));
    if (!ok) throw new Error('Empreinte refusée.');
    if (ad.signCount && Number(key.sign_count) && ad.signCount <= Number(key.sign_count)) throw new Error('Clé copiée détectée : empreinte refusée.');
    await db.query('UPDATE admin_passkeys SET sign_count = $2, last_used_at = now() WHERE id = $1', [key.id, ad.signCount]);
  }

  // ---------- Connexion par empreinte (après le mot de passe) ----------
  app.post('/api/admin/auth/login/webauthn', rateLimit('adminwebauthn', 20, 15 * 60 * 1000), async (req, res) => {
    const origin = originOf(req);
    const adminId = String(req.body && req.body.adminId || '');
    if (!origin || !/^[0-9a-f-]{36}$/i.test(adminId)) return res.status(400).json({ error: 'Demande invalide.' });
    try {
      await verifyAssertion({ adminId, credential: req.body.credential, origin });
    } catch (e) {
      await security.log('admin_empreinte_refusee', 'critique', { detail: `Empreinte refusée pour l'administrateur principal : ${e.message}` }).catch(() => {});
      return res.status(401).json({ error: e.message });
    }
    const admin = await db.query("SELECT id, role FROM admins WHERE id = $1 AND status = 'actif'", [adminId]);
    if (!admin) return res.status(401).json({ error: 'Administrateur inconnu ou suspendu.' });
    // Le code envoyé par email pour cette connexion n'est plus utilisable.
    await db.query('UPDATE admin_verifications SET verified = TRUE WHERE admin_id = $1 AND verified = FALSE', [adminId]);
    res.json({ token: signSessionToken(adminId, { typ: 'admin', ttl: admin.role === 'admin_principal' ? PRINCIPAL_TTL_MS : undefined }), adminId, role: admin.role });
  });

  async function checkPassword(adminId, password) {
    const a = await db.query('SELECT password_hash FROM admins WHERE id = $1', [adminId]);
    return Boolean(a && a.password_hash && password && await bcrypt.compare(String(password), a.password_hash));
  }

  // ---------- Réglages de connexion (Sécurité) ----------
  app.get('/api/admin/login-settings', requireAdminPrincipal, async (req, res) => {
    const a = await db.query('SELECT email FROM admins WHERE id = $1', [req.adminId]);
    const keys = await db.all('SELECT id, label, created_at, last_used_at FROM admin_passkeys WHERE admin_id = $1 ORDER BY created_at', [req.adminId]);
    res.json({ email: a && a.email ? maskEmail(a.email) : null, hasEmail: Boolean(a && a.email), passkeys: keys });
  });

  app.post('/api/admin/login-settings/email', requireAdminPrincipal, rateLimit('adminemail', 10, 60 * 60 * 1000), async (req, res) => {
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    if (!(await checkPassword(req.adminId, req.body && req.body.password))) return res.status(403).json({ error: 'Mot de passe administrateur incorrect.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160) return res.status(400).json({ error: 'Adresse email invalide.' });
    await db.query('UPDATE admins SET email = $1 WHERE id = $2', [email, req.adminId]);
    const sent = await trySendEmail(email, 'Eaji Admin — email de connexion enregistré',
      "Cette adresse recevra désormais les codes de connexion au tableau d'administration Eaji.\n\nSi ce n'est pas toi, change tout de suite ton mot de passe administrateur.");
    await security.log('admin_email_change', 'alerte', { detail: `Email de connexion de l'administrateur principal changé (${maskEmail(email)}).` }).catch(() => {});
    res.json({ saved: true, email: maskEmail(email), testSent: sent });
  });

  // Enregistrer l'empreinte de ce téléphone : 1) options, 2) réponse du téléphone.
  app.post('/api/admin/passkeys/options', requireAdminPrincipal, async (req, res) => {
    const origin = originOf(req);
    if (!origin) return res.status(400).json({ error: "Ouvre le tableau d'administration depuis son adresse habituelle pour enregistrer l'empreinte." });
    if (!(await checkPassword(req.adminId, req.body && req.body.password))) return res.status(403).json({ error: 'Mot de passe administrateur incorrect.' });
    const a = await db.query('SELECT name FROM admins WHERE id = $1', [req.adminId]);
    const existing = await db.all('SELECT credential_id FROM admin_passkeys WHERE admin_id = $1', [req.adminId]);
    const challenge = b64u(crypto.randomBytes(32));
    await db.query(
      "INSERT INTO admin_webauthn_challenges (admin_id, challenge, kind, origin, expires_at) VALUES ($1, $2, 'inscription', $3, now() + interval '5 minutes')",
      [req.adminId, challenge, origin]);
    res.json({
      challenge, rp: { id: new URL(origin).hostname, name: 'Eaji Admin' },
      user: { id: b64u(Buffer.from(req.adminId)), name: (a && a.name) || 'Administrateur', displayName: (a && a.name) || 'Administrateur' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      excludeCredentials: existing.map((k) => k.credential_id), attestation: 'none', timeout: 60000,
    });
  });

  app.post('/api/admin/passkeys', requireAdminPrincipal, async (req, res) => {
    const origin = originOf(req);
    const c = req.body && req.body.credential;
    try {
      if (!origin || !c || !c.response) throw new Error('Demande invalide.');
      const clientDataJSON = fromB64u(c.response.clientDataJSON);
      const cd = JSON.parse(clientDataJSON.toString('utf8'));
      if (cd.type !== 'webauthn.create' || cd.origin !== origin) throw new Error('Réponse du téléphone invalide.');
      const ch = await db.query(
        "SELECT * FROM admin_webauthn_challenges WHERE admin_id = $1 AND challenge = $2 AND kind = 'inscription' AND used = FALSE AND expires_at > now()",
        [req.adminId, String(cd.challenge || '')]);
      if (!ch) throw new Error('Demande expirée : recommence.');
      await db.query('UPDATE admin_webauthn_challenges SET used = TRUE WHERE id = $1', [ch.id]);
      const [att] = cborDecode(fromB64u(c.response.attestationObject));
      const ad = parseAuthData(att.get('authData'));
      if (!ad.rpIdHash.equals(sha256(Buffer.from(new URL(origin).hostname)))) throw new Error('Empreinte faite pour un autre site.');
      if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new Error("L'empreinte (ou le code du téléphone) n'a pas été vérifiée.");
      if (!ad.credentialId || !ad.cose) throw new Error('Clé du téléphone manquante.');
      const { alg, jwk } = coseToKey(ad.cose);
      crypto.createPublicKey({ key: jwk, format: 'jwk' }); // vérifie que la clé est valide
      const label = String(req.body.label || '').trim().slice(0, 60) || 'Téléphone';
      await db.query(
        'INSERT INTO admin_passkeys (admin_id, credential_id, public_key, alg, sign_count, label) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.adminId, b64u(ad.credentialId), JSON.stringify(jwk), alg, ad.signCount, label]);
      await security.log('admin_empreinte_ajoutee', 'alerte', { detail: `Empreinte ajoutée pour l'administrateur principal (${label}).` }).catch(() => {});
      res.status(201).json({ saved: true });
    } catch (e) {
      res.status(400).json({ error: /duplicate|unique/i.test(e.message) ? 'Cette empreinte est déjà enregistrée.' : e.message });
    }
  });

  app.delete('/api/admin/passkeys/:id', requireAdminPrincipal, async (req, res) => {
    if (!(await checkPassword(req.adminId, req.body && req.body.password))) return res.status(403).json({ error: 'Mot de passe administrateur incorrect.' });
    const r = await db.query('DELETE FROM admin_passkeys WHERE id = $1 AND admin_id = $2 RETURNING id', [req.params.id, req.adminId]);
    if (!r) return res.status(404).json({ error: 'Empreinte introuvable.' });
    await security.log('admin_empreinte_retiree', 'alerte', { detail: "Une empreinte de l'administrateur principal a été retirée." }).catch(() => {});
    res.json({ deleted: true });
  });

  return { startPrincipal };
}

// La connexion de l'administrateur principal ne dure jamais plus de 12 heures (sécurité), même si la page reste ouverte.
const PRINCIPAL_TTL_MS = 12 * 60 * 60 * 1000;

module.exports = { MIGRATIONS, register, PRINCIPAL_TTL_MS, cborDecode, parseAuthData };
