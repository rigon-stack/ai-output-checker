-- Model replies that arrived but couldn't be used, kept so we can see what went wrong.
CREATE TABLE IF NOT EXISTS quarantine (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  text       TEXT        NOT NULL,
  rules      JSONB       NOT NULL,
  raw_reply  TEXT        NOT NULL,
  reason     TEXT        NOT NULL
);
