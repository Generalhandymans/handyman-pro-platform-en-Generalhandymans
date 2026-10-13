-- 010_events.sql — business events (stage changes, confirmed payments). Mirrors db.js.
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id INTEGER,
  data TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);
