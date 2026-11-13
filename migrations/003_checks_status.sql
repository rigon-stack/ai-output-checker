-- Failed model calls now count toward the daily limit, so they are saved as rows too.
-- status tells them apart; result is empty for a failed call because there is no verdict.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed'));
ALTER TABLE checks ALTER COLUMN result DROP NOT NULL;
