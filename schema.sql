-- Eaji — Schéma de base de données consolidé
-- PostgreSQL
-- Regroupe : créateurs, abonnés, taux, paiements, contenus, modération, admins.

-- ==================== CRÉATEURS ====================

CREATE TABLE creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  country_code CHAR(2) NOT NULL,
  zone TEXT NOT NULL CHECK (zone IN ('afrique', 'caraibes', 'asie', 'europe_centrale')),
  primary_content_type TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'fr',
  gift_currency TEXT NOT NULL DEFAULT 'USD', -- devise choisie par le créateur pour recevoir les cadeaux
  account_status TEXT NOT NULL DEFAULT 'actif' CHECK (account_status IN ('actif', 'suspendu', 'supprime')),
  profile_visibility TEXT NOT NULL DEFAULT 'prive' CHECK (profile_visibility IN ('prive', 'public')),
  subscriber_count_public BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'en_attente' CHECK (verification_status IN ('en_attente', 'verifie', 'rejete')),
  two_factor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  photo_url TEXT,
  withdrawal_phone TEXT, -- numéro mobile money utilisé pour les retraits (peut différer du téléphone de connexion)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Le solde/revenu n'est jamais exposé publiquement : accès applicatif
-- restreint au propriétaire uniquement (pas de colonne "public" ici).
CREATE TABLE creator_balances (
  creator_id UUID PRIMARY KEY REFERENCES creators(id),
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriber_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  platform TEXT NOT NULL,
  subscriber_count INTEGER NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== SÉCURITÉ DU COMPTE ====================

CREATE TABLE account_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'gmail')),
  code_hash TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES creators(id),
  ip_address TEXT,
  device_fingerprint TEXT,
  success BOOLEAN NOT NULL,
  flagged BOOLEAN NOT NULL DEFAULT FALSE, -- déclenche l'alerte immédiate si TRUE
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Journal d'activité chiffré au repos (chiffrement géré au niveau
-- applicatif ou disque, pas dans ce schéma).
CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  action TEXT NOT NULL,
  encrypted_payload BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== PAIEMENTS ====================

CREATE TABLE payout_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone TEXT NOT NULL,
  content_type TEXT NOT NULL,
  rate_per_subscriber NUMERIC(8,4) NOT NULL,
  currency TEXT NOT NULL,
  effective_from DATE NOT NULL,
  UNIQUE (zone, content_type, effective_from)
);

CREATE TABLE payout_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'mobile_money', 'manual_review')),
  aggregator TEXT,
  external_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente', 'actif', 'suspendu')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== CONTENUS & MODÉRATION ====================

CREATE TABLE content_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  content_type TEXT NOT NULL CHECK (content_type IN (
    'live', 'podcast', 'telechargement', 'publication', 'audio',
    'video_courte', 'video_longue', 'photo', 'livre', 'pdf', 'powerpoint', 'film', 'musique'
  )),
  title TEXT NOT NULL,
  storage_url TEXT NOT NULL, -- lien signé vers le stockage objet (S3-compatible) — pas stocké en base
  file_size_bytes BIGINT, -- vérifié côté serveur contre la limite du type (voir content-limits.js)
  visibility_scope TEXT NOT NULL DEFAULT 'public' CHECK (visibility_scope IN ('public', 'abonnes')),
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'retire')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID NOT NULL REFERENCES content_items(id),
  reported_by UUID REFERENCES creators(id), -- NULL si signalement automatique
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "J'aime" sur un contenu — un créateur ne peut aimer un même contenu qu'une fois.
CREATE TABLE content_likes (
  content_id UUID NOT NULL REFERENCES content_items(id),
  creator_id UUID NOT NULL REFERENCES creators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, creator_id)
);

CREATE TABLE content_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID NOT NULL REFERENCES content_items(id),
  creator_id UUID NOT NULL REFERENCES creators(id),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Abonnements entre créateurs (qui suit qui) — distinct du compteur
-- "subscriber_counts" qui vient des plateformes externes du créateur.
CREATE TABLE follows (
  follower_id UUID NOT NULL REFERENCES creators(id),
  followed_id UUID NOT NULL REFERENCES creators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id)
);

-- ==================== LIVE, CADEAUX, MESSAGERIE ====================

CREATE TABLE live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  status TEXT NOT NULL DEFAULT 'en_cours' CHECK (status IN ('en_cours', 'termine')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

-- Cadeaux en argent envoyés par un abonné sur un contenu ou un live.
-- La devise est toujours celle choisie par le créateur destinataire (gift_currency).
CREATE TABLE gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_creator_id UUID NOT NULL REFERENCES creators(id),
  to_creator_id UUID NOT NULL REFERENCES creators(id),
  content_id UUID REFERENCES content_items(id),
  live_session_id UUID REFERENCES live_sessions(id),
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (content_id IS NOT NULL OR live_session_id IS NOT NULL)
);

CREATE TABLE direct_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES creators(id),
  recipient_id UUID NOT NULL REFERENCES creators(id),
  text TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== ESPACE PUBLICITAIRE (VENTES EN LIGNE) ====================

-- Abonnement payant qui rend les articles d'un créateur visibles aux abonnés
-- ET aux non-abonnés, pendant une durée limitée. Génère un revenu crédité à
-- l'administrateur principal (voir ad_payments plus bas).
CREATE TABLE ad_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  tier TEXT NOT NULL CHECK (tier IN ('basique', 'standard', 'illimite')), -- 5$/20$/100$
  article_limit INTEGER, -- NULL = illimité (palier "illimite")
  price NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'expire')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Les articles (contenus) promus par un abonnement publicitaire donné,
-- jusqu'à la limite article_limit de l'abonnement.
CREATE TABLE ad_listings (
  ad_subscription_id UUID NOT NULL REFERENCES ad_subscriptions(id),
  content_id UUID NOT NULL REFERENCES content_items(id),
  PRIMARY KEY (ad_subscription_id, content_id)
);

-- Tout paiement d'abonnement publicitaire encaissé — n'est, comme les
-- commissions, jamais visible par un administrateur secondaire (voir plus bas).
CREATE TABLE ad_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_subscription_id UUID NOT NULL REFERENCES ad_subscriptions(id),
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== SÉCURITÉ RENFORCÉE ====================

-- Demande de changement de numéro de téléphone : nécessite une vérification
-- avant de remplacer l'ancien numéro (jamais un changement direct sans code).
CREATE TABLE phone_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  new_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permissions accordées à un administrateur secondaire — jamais à l'administrateur
-- principal, qui a tout par défaut. Seul l'administrateur principal peut écrire ici.
-- Note : aucune permission financière n'existe ici volontairement. Les commissions
-- et paiements publicitaires restent exclusifs à l'administrateur principal
-- (vérifié en dur dans l'API, pas via ce système de permissions délégables).
CREATE TABLE admin_permissions (
  admin_id UUID NOT NULL REFERENCES admins(id),
  permission TEXT NOT NULL CHECK (permission IN (
    'moderer_contenu', 'gerer_comptes_utilisateurs', 'repondre_signalements'
  )),
  granted_by UUID NOT NULL REFERENCES admins(id),
  PRIMARY KEY (admin_id, permission)
);

-- Tentatives de connexion au(x) compte(s) administrateur — distinct de login_attempts
-- (qui concerne les créateurs), avec un niveau de sensibilité plus élevé.
CREATE TABLE admin_login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_attempted TEXT,
  ip_address TEXT,
  device_fingerprint TEXT,
  success BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Une tentative suspecte sur le compte admin envoie ce code par SMS à
-- Jimmy Komba ; sa confirmation bloque la source définitivement.
CREATE TABLE admin_security_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT,
  device_fingerprint TEXT,
  confirmation_code_hash TEXT NOT NULL,
  confirmed_block BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE security_blocklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT,
  device_fingerprint TEXT,
  reason TEXT NOT NULL,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE moderation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID NOT NULL REFERENCES content_items(id),
  admin_id UUID NOT NULL, -- référence admins.id
  action TEXT NOT NULL CHECK (action IN ('retrait', 'avertissement', 'restauration')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== ADMINISTRATION ====================

CREATE TABLE admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin_principal', 'admin')),
  approved_by UUID REFERENCES admins(id), -- NULL uniquement pour l'admin principal fondateur
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'suspendu')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un même admin principal peut se connecter avec plusieurs numéros.
CREATE TABLE admin_phone_numbers (
  admin_id UUID NOT NULL REFERENCES admins(id),
  phone TEXT NOT NULL,
  PRIMARY KEY (admin_id, phone)
);

CREATE TABLE admin_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admins(id),
  creator_id UUID NOT NULL REFERENCES creators(id),
  type TEXT NOT NULL CHECK (type IN ('ouverture', 'retrait')),
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== DONNÉE INITIALE ====================

-- Administrateur principal (Jimmy Komba), à insérer au déploiement initial.
-- INSERT INTO admins (name, role) VALUES ('Jimmy Komba', 'admin_principal');
-- Puis lier les deux numéros dans admin_phone_numbers.
