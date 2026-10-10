-- Script de mise à jour — sûr à exécuter même si une partie existe déjà.

-- ---- creators : nouvelles colonnes ----
ALTER TABLE creators ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS withdrawal_phone TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'fr';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS gift_currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'actif';

-- ---- content_items : nouvelle colonne + nouveaux types de contenu ----
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_content_type_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_content_type_check CHECK (content_type IN (
  'live', 'podcast', 'telechargement', 'publication', 'audio',
  'video_courte', 'video_longue', 'photo', 'livre', 'pdf', 'powerpoint', 'film', 'musique'
));

-- ---- admins : mot de passe ----
ALTER TABLE admins ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- ---- Fil social ----
CREATE TABLE IF NOT EXISTS content_likes (
  content_id UUID NOT NULL REFERENCES content_items(id),
  creator_id UUID NOT NULL REFERENCES creators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, creator_id)
);

CREATE TABLE IF NOT EXISTS content_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID NOT NULL REFERENCES content_items(id),
  creator_id UUID NOT NULL REFERENCES creators(id),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES creators(id),
  followed_id UUID NOT NULL REFERENCES creators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id)
);

-- ---- Live, cadeaux, messagerie ----
CREATE TABLE IF NOT EXISTS live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  status TEXT NOT NULL DEFAULT 'en_cours' CHECK (status IN ('en_cours', 'termine')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gifts (
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

CREATE TABLE IF NOT EXISTS direct_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES creators(id),
  recipient_id UUID NOT NULL REFERENCES creators(id),
  text TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Espace publicitaire ----
CREATE TABLE IF NOT EXISTS ad_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  tier TEXT NOT NULL CHECK (tier IN ('basique', 'standard', 'illimite')),
  article_limit INTEGER,
  price NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'expire')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_listings (
  ad_subscription_id UUID NOT NULL REFERENCES ad_subscriptions(id),
  content_id UUID NOT NULL REFERENCES content_items(id),
  PRIMARY KEY (ad_subscription_id, content_id)
);

CREATE TABLE IF NOT EXISTS ad_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_subscription_id UUID NOT NULL REFERENCES ad_subscriptions(id),
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Sécurité renforcée ----
CREATE TABLE IF NOT EXISTS phone_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES creators(id),
  new_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_permissions (
  admin_id UUID NOT NULL REFERENCES admins(id),
  permission TEXT NOT NULL CHECK (permission IN (
    'moderer_contenu', 'gerer_comptes_utilisateurs', 'repondre_signalements'
  )),
  granted_by UUID NOT NULL REFERENCES admins(id),
  PRIMARY KEY (admin_id, permission)
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_attempted TEXT,
  ip_address TEXT,
  device_fingerprint TEXT,
  success BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_security_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT,
  device_fingerprint TEXT,
  confirmation_code_hash TEXT NOT NULL,
  confirmed_block BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_blocklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT,
  device_fingerprint TEXT,
  reason TEXT NOT NULL,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Vérification 2FA dédiée aux administrateurs ----
CREATE TABLE IF NOT EXISTS admin_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admins(id),
  code_hash TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
