-- Migration number: 0013   2026-09-12T00:00:00.000Z
--
-- Fallback menu / Quick Answers feature.
--
-- PURPOSE:
--   Lets bot owners configure up to 8 owner-authored question-and-response
--   pairs. These are used in two scenarios:
--     1. Shown as tappable quick-reply chips in the widget when Quick Answers
--        are enabled (opt-in during normal AI operation).
--     2. Shown as fallback menu buttons when the bot's daily AI quota is
--        exhausted, so visitors are never left with a dead widget.
--
-- CHANGES TO `bots`:
--   Adds quick_answers_enabled column (0=disabled, 1=enabled).
--   Default 0 — owners must explicitly enable.
--
-- DESIGN:
--   Flat list, no nesting, no conditional branching.
--   Max 8 items per bot enforced at API level.
--   display_order 0–7; items sorted ascending for rendering.
--   Labels and responses are owner-authored; PreBase does not verify accuracy.

ALTER TABLE bots ADD COLUMN quick_answers_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS bot_menu_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT    NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,          -- max 40 chars, enforced at API level
  response      TEXT    NOT NULL,          -- max 1000 chars, enforced at API level
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_menu_items_bot ON bot_menu_items(bot_id, display_order);
