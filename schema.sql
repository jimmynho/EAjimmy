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
  profile_visibility TEXT NOT NULL DEFAULT 'prive' CHECK (profile_visibility IN ('prive', 'public')),
  subscriber_count_public BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'en_attente' CHECK (verification_status IN ('en_attente', 'verifie', 'rejete')),
  two_factor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
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
    'video_courte', 'video_longue', 'photo', 'livre', 'pdf', 'powerpoint'
  )),
  title TEXT NOT NULL,
  storage_url TEXT NOT NULL, -- lien signé vers le stockage objet (S3-compatible)
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
