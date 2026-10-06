-- Revoked JWTs (logout). Rows expire with the token and are purged by the maintenance job.
CREATE TABLE revoked_tokens (
  jti        text PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX revoked_tokens_exp_idx ON revoked_tokens(expires_at);
