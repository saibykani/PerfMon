-- Object storage inside PostgreSQL (STORAGE_DRIVER=postgres) for hosts without a persistent disk
-- (e.g. free cloud tiers). Objects are split into chunks so large files stream in and out.
CREATE TABLE IF NOT EXISTS object_blobs (
  key           text PRIMARY KEY,
  content_type  text,
  size          bigint NOT NULL DEFAULT 0,
  chunks        int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS object_blob_chunks (
  key   text NOT NULL REFERENCES object_blobs(key) ON DELETE CASCADE,
  idx   int NOT NULL,
  data  bytea NOT NULL,
  PRIMARY KEY (key, idx)
);
