-- Migration number: 0009 	 2026-09-10T00:00:00.000Z

-- Add runtime_calls column to groq_usage table for tracking daily runtime retrieval helper calls
ALTER TABLE groq_usage ADD COLUMN runtime_calls INTEGER DEFAULT 0;
