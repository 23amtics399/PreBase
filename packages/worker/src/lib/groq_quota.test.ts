import {
  atomicReserveGroqQuota,
  updateGroqTokenLedger,
  readGroqQuotaLedger,
} from './ratelimit';
import type { D1Database } from '@cloudflare/workers-types';

interface LedgerRow {
  day: string;
  model_id: string;
  use_case: string;
  request_count: number;
  est_input_tokens: number;
  est_output_tokens: number;
  act_input_tokens: number;
  act_output_tokens: number;
}

/**
 * Creates an in-memory simulated D1 database for groq_quota_ledger
 * mimicking SQLite serialised writes and atomic upserts.
 */
function createSimulatedD1(): { db: D1Database; store: Map<string, LedgerRow> } {
  const store = new Map<string, LedgerRow>();

  const getOrCreateRow = (day: string, modelId: string, useCase: string): LedgerRow => {
    const key = `${day}:${modelId}:${useCase}`;
    let row = store.get(key);
    if (!row) {
      row = {
        day,
        model_id: modelId,
        use_case: useCase,
        request_count: 0,
        est_input_tokens: 0,
        est_output_tokens: 0,
        act_input_tokens: 0,
        act_output_tokens: 0,
      };
      store.set(key, row);
    }
    return row;
  };

  const db = {
    prepare: (query: string) => {
      let boundParams: any[] = [];
      return {
        bind: (...params: any[]) => {
          boundParams = params;
          return {
            first: async <T>(): Promise<T | null> => {
              // 1. Check if it's the atomic increment upsert for groq_quota_ledger
              if (query.includes('INSERT INTO groq_quota_ledger') && query.includes('request_count = request_count + 1')) {
                // (day, model_id, use_case, request_count) VALUES (?, ?, '__model__', 1) -> boundParams = [day, modelId]
                // OR VALUES (?, ?, ?, 1) -> boundParams = [day, modelId, useCase]
                const day = boundParams[0];
                const modelId = boundParams[1];
                const useCase = boundParams.length > 2 ? boundParams[2] : '__model__';

                const row = getOrCreateRow(day, modelId, useCase);
                row.request_count += 1;
                return { request_count: row.request_count } as unknown as T;
              }

              // 2. Check if it's a SELECT from groq_quota_ledger
              if (query.includes('SELECT') && query.includes('FROM groq_quota_ledger')) {
                const day = boundParams[0];
                const modelId = boundParams[1];
                const useCase = boundParams[2];
                const key = `${day}:${modelId}:${useCase}`;
                const row = store.get(key);
                return (row ? { ...row } : null) as unknown as T;
              }

              return null;
            },
            run: async () => {
              // 1. Rollback decrement: UPDATE groq_quota_ledger SET request_count = MAX(0, request_count - 1)
              if (query.includes('UPDATE groq_quota_ledger') && query.includes('MAX(0, request_count - 1)')) {
                const day = boundParams[0];
                const modelId = boundParams[1];
                const useCase = boundParams.length > 2 ? boundParams[2] : '__model__';
                const key = `${day}:${modelId}:${useCase}`;
                const row = store.get(key);
                if (row) {
                  row.request_count = Math.max(0, row.request_count - 1);
                }
                return { success: true };
              }

              // 2. Token ledger update: INSERT INTO groq_quota_ledger ... DO UPDATE SET est_input_tokens = ...
              if (query.includes('INSERT INTO groq_quota_ledger') && query.includes('excluded.est_input_tokens')) {
                const day = boundParams[0];
                const modelId = boundParams[1];
                const useCase = boundParams[2];
                const estInput = Number(boundParams[3]) || 0;
                const estOutput = Number(boundParams[4]) || 0;
                const actInput = Number(boundParams[5]) || 0;
                const actOutput = Number(boundParams[6]) || 0;

                const row = getOrCreateRow(day, modelId, useCase);
                row.est_input_tokens += estInput;
                row.est_output_tokens += estOutput;
                row.act_input_tokens += actInput;
                row.act_output_tokens += actOutput;
                return { success: true };
              }

              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, store };
}

describe('groq_quota_ledger: atomicReserveGroqQuota & Concurrency Safety', () => {
  const DAY = '2026-09-10';
  const QWEN_38 = 'qwen/qwen3.8-27b';
  const QWEN_36 = 'qwen/qwen3.6-27b';
  const GUARD_MODEL = 'meta-llama/llama-prompt-guard-2-86m';

  it('allows reservation when both use-case budget and combined ceiling are not exceeded', async () => {
    const { db, store } = createSimulatedD1();

    const res = await atomicReserveGroqQuota(db, DAY, QWEN_38, 'ingestion', 650, 950);
    expect(res.allowed).toBe(true);
    expect(res.count).toBe(1);

    const sentinel = store.get(`${DAY}:${QWEN_38}:__model__`);
    const ingestion = store.get(`${DAY}:${QWEN_38}:ingestion`);

    expect(sentinel?.request_count).toBe(1);
    expect(ingestion?.request_count).toBe(1);
  });

  it('enforces per-use-case budget and rolls back the sentinel row when exceeded', async () => {
    const { db, store } = createSimulatedD1();

    // Fill ingestion budget of 2
    await atomicReserveGroqQuota(db, DAY, QWEN_38, 'ingestion', 2, 950);
    await atomicReserveGroqQuota(db, DAY, QWEN_38, 'ingestion', 2, 950);

    // 3rd attempt exceeds ingestion budget
    const res = await atomicReserveGroqQuota(db, DAY, QWEN_38, 'ingestion', 2, 950);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('uc_budget');

    // Verify sentinel row was rolled back to 2, not left at 3
    const sentinel = store.get(`${DAY}:${QWEN_38}:__model__`);
    const ingestion = store.get(`${DAY}:${QWEN_38}:ingestion`);
    expect(sentinel?.request_count).toBe(2);
    expect(ingestion?.request_count).toBe(2);

    // Runtime should still be able to reserve because its own budget is not full and ceiling is 950
    const runtimeRes = await atomicReserveGroqQuota(db, DAY, QWEN_38, 'runtime', 300, 950);
    expect(runtimeRes.allowed).toBe(true);
    expect(runtimeRes.count).toBe(1);
    expect(sentinel?.request_count).toBe(3);
  });

  it('enforces atomic combined model ceiling across multiple use cases', async () => {
    const { db, store } = createSimulatedD1();
    const CEILING = 5;

    // Ingestion reserves 3 slots
    for (let i = 0; i < 3; i++) {
      const res = await atomicReserveGroqQuota(db, DAY, QWEN_38, 'ingestion', 10, CEILING);
      expect(res.allowed).toBe(true);
    }

    // Runtime reserves 2 slots -> total is now 5 (= ceiling)
    for (let i = 0; i < 2; i++) {
      const res = await atomicReserveGroqQuota(db, DAY, QWEN_38, 'runtime', 10, CEILING);
      expect(res.allowed).toBe(true);
    }

    const sentinel = store.get(`${DAY}:${QWEN_38}:__model__`);
    expect(sentinel?.request_count).toBe(5);

    // 6th request from runtime must be blocked by model_ceiling
    const rejectedRuntime = await atomicReserveGroqQuota(db, DAY, QWEN_38, 'runtime', 10, CEILING);
    expect(rejectedRuntime.allowed).toBe(false);
    expect(rejectedRuntime.reason).toBe('model_ceiling');

    // 6th request from ingestion must also be blocked by model_ceiling
    const rejectedIngestion = await atomicReserveGroqQuota(db, DAY, QWEN_38, 'ingestion', 10, CEILING);
    expect(rejectedIngestion.allowed).toBe(false);
    expect(rejectedIngestion.reason).toBe('model_ceiling');

    // Sentinel row must remain exactly at 5
    expect(sentinel?.request_count).toBe(5);
  });

  it('maintains strict isolation between different models (qwen3.8 vs qwen3.6 vs prompt guard)', async () => {
    const { db, store } = createSimulatedD1();

    // Reserve on Qwen 3.8
    await atomicReserveGroqQuota(db, DAY, QWEN_38, 'runtime', 300, 950);

    // Reserve on Qwen 3.6 (independent model pool, its own sentinel ceiling)
    await atomicReserveGroqQuota(db, DAY, QWEN_36, 'runtime', 100, 100);

    // Reserve on Prompt Guard (no ceiling, only use_case budget)
    await atomicReserveGroqQuota(db, DAY, GUARD_MODEL, 'guard', 5000);

    expect(store.get(`${DAY}:${QWEN_38}:__model__`)?.request_count).toBe(1);
    expect(store.get(`${DAY}:${QWEN_36}:__model__`)?.request_count).toBe(1);
    expect(store.get(`${DAY}:${GUARD_MODEL}:__model__`)).toBeUndefined(); // Prompt Guard has no sentinel row
    expect(store.get(`${DAY}:${GUARD_MODEL}:guard`)?.request_count).toBe(1);
  });

  it('simulates concurrent writers racing against the combined ceiling without exceeding it', async () => {
    const { db, store } = createSimulatedD1();
    const CEILING = 20;

    // 50 runtime attempts and 50 ingestion attempts run concurrently
    const runtimePromises = Array.from({ length: 50 }, () =>
      atomicReserveGroqQuota(db, DAY, QWEN_38, 'runtime', 30, CEILING)
    );
    const ingestionPromises = Array.from({ length: 50 }, () =>
      atomicReserveGroqQuota(db, DAY, QWEN_38, 'ingestion', 30, CEILING)
    );

    const results = await Promise.all([...runtimePromises, ...ingestionPromises]);

    const allowed = results.filter(r => r.allowed);
    const denied = results.filter(r => !r.allowed);

    // Exactly CEILING requests must succeed
    expect(allowed.length).toBe(CEILING);
    expect(denied.length).toBe(100 - CEILING);

    // All denied results should cite model_ceiling
    for (const d of denied) {
      expect(d.reason).toBe('model_ceiling');
    }

    // Invariant: SUM(request_count) == CEILING
    const sentinelCount = store.get(`${DAY}:${QWEN_38}:__model__`)?.request_count;
    const runtimeCount = store.get(`${DAY}:${QWEN_38}:runtime`)?.request_count ?? 0;
    const ingestionCount = store.get(`${DAY}:${QWEN_38}:ingestion`)?.request_count ?? 0;

    expect(sentinelCount).toBe(CEILING);
    expect(runtimeCount + ingestionCount).toBe(CEILING);
  });

  it('records token usage in groq_quota_ledger and never updates __model__ sentinel row', async () => {
    const { db } = createSimulatedD1();

    await updateGroqTokenLedger(db, DAY, QWEN_38, 'runtime', {
      estInput: 50,
      estOutput: 256,
      actInput: 45,
      actOutput: 120,
    });

    await updateGroqTokenLedger(db, DAY, QWEN_38, 'runtime', {
      estInput: 30,
      estOutput: 256,
      actInput: 28,
      actOutput: 80,
    });

    // Attempting to update sentinel row should be ignored
    await updateGroqTokenLedger(db, DAY, QWEN_38, '__model__', {
      estInput: 100,
      estOutput: 100,
    });

    const runtimeRow = await readGroqQuotaLedger(db, DAY, QWEN_38, 'runtime');
    expect(runtimeRow).not.toBeNull();
    expect(runtimeRow?.est_input_tokens).toBe(80);
    expect(runtimeRow?.est_output_tokens).toBe(512);
    expect(runtimeRow?.act_input_tokens).toBe(73);
    expect(runtimeRow?.act_output_tokens).toBe(200);
    expect(runtimeRow?.request_count).toBe(0); // Token updates do not increment request_count

    const sentinelRow = await readGroqQuotaLedger(db, DAY, QWEN_38, '__model__');
    expect(sentinelRow).toBeNull();
  });
});
