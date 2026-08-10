ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS password_hash TEXT,
ADD COLUMN IF NOT EXISTS reset_token TEXT,
ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_reset_token
ON public.profiles (reset_token)
WHERE reset_token IS NOT NULL;
