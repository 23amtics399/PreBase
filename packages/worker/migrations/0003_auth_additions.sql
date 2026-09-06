-- Migration number: 0003 	 2026-09-06T00:00:00.000Z
-- Rename pass_hash to password_hash to better align with the new standard format
ALTER TABLE users RENAME COLUMN pass_hash TO password_hash;

-- Rate limiting table for authentication endpoints to prevent abuse
CREATE TABLE auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  attempt_time INTEGER NOT NULL
);
CREATE INDEX idx_auth_attempts_ip_time ON auth_attempts(ip_hash, attempt_time);
