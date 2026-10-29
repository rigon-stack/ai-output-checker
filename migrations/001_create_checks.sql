CREATE TABLE IF NOT EXISTS checks (
  id         BIGSERIAL PRIMARY KEY,
  text       TEXT        NOT NULL,
  rules      JSONB       NOT NULL,
  result     TEXT        NOT NULL CHECK (result IN ('pass', 'flag')),
  reasons    JSONB       NOT NULL DEFAULT '[]',
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
