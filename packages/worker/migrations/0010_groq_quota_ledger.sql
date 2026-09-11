-- Migration number: 0010 	 2026-09-10T00:00:00.000Z
--
-- Creates groq_quota_ledger: generic per-model, per-use-case quota ledger.
-- Replaces the use-case-specific groq_usage table (ingestion_calls, runtime_calls).
--
-- groq_usage is preserved read-only for historical reference.
-- groq_usage will be dropped after 30 days of ledger data (separate migration).
--
-- KEY DESIGN RULES (from quota_architecture_v2.md):
--   - model_id is the primary key for provider quota accounting.
--   - qwen/qwen3.8-27b and qwen/qwen3.6-27b are ALWAYS separate rows.
--   - use_case = '__model__' is a SENTINEL row used to enforce the combined
--     model-level ceiling atomically (see ATOMIC CEILING DESIGN below).
--   - est_* fields are PreBase estimates. NOT authoritative provider accounting.
--   - act_* fields are provider-reported from response.usage when available.
--     They are observability data only. NOT authoritative provider accounting.
--   - request_count is the ONLY field used for hard enforcement decisions.
--
-- ATOMIC CEILING DESIGN (for qwen/qwen3.8-27b 950/day ceiling):
--   For any model with a combined ceiling, a sentinel row (use_case='__model__')
--   acts as the single atomic gate. When reserving:
--     1. Atomically increment (day, model_id, '__model__'). If > ceiling, roll back.
--     2. Atomically increment (day, model_id, use_case). If > budget, roll back both.
--   SQLite serializes all writes. Both concurrent requests race on the sentinel row.
--   Only ONE can hold a given slot. The second sees the post-increment value
--   and is denied. No SELECT-before-UPDATE race condition exists.

CREATE TABLE IF NOT EXISTS groq_quota_ledger (
  day               TEXT    NOT NULL,  -- 'YYYY-MM-DD' UTC
  model_id          TEXT    NOT NULL,  -- Groq model ID, e.g. 'qwen/qwen3.8-27b'
  use_case          TEXT    NOT NULL,  -- 'guard'|'runtime'|'ingestion'|'__model__'
  -- Enforcement counter (Layer 2). Only this field drives allow/deny decisions.
  request_count     INTEGER NOT NULL DEFAULT 0,
  -- Layer 3: observability only (only on actual use-case rows, not '__model__').
  est_input_tokens  INTEGER NOT NULL DEFAULT 0,  -- estimate from request params
  est_output_tokens INTEGER NOT NULL DEFAULT 0,  -- max_tokens parameter
  act_input_tokens  INTEGER NOT NULL DEFAULT 0,  -- response.usage.prompt_tokens
  act_output_tokens INTEGER NOT NULL DEFAULT 0,  -- response.usage.completion_tokens
  PRIMARY KEY (day, model_id, use_case)
);
