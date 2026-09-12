-- Migration number: 0011    2026-09-12T00:00:00.000Z
--
-- Adds source_type column to kb_sources.
-- Valid values: 'file' | 'text'

ALTER TABLE kb_sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'file';
