CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamp NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
