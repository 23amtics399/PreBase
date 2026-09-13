import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Model of the frontend manual refresh & cooldown logic in bot.js.
 * Verifies that:
 * 1. No automatic polling timers or background intervals are started.
 * 2. Manual refresh makes exactly one network request per click.
 * 3. A 10-second client-side cooldown blocks repeated requests.
 * 4. Refresh is re-enabled once the cooldown expires.
 */
function createMockEnrichmentController(sources: any[], fetchSources: () => Promise<any[]>) {
  let isRefreshing = false;
  let cooldownUntil = 0;
  let currentSources = [...sources];

  async function handleManualRefresh() {
    if (isRefreshing || Date.now() < cooldownUntil) {
      return { triggered: false, reason: isRefreshing ? 'in_flight' : 'cooldown' };
    }

    isRefreshing = true;
    try {
      const updated = await fetchSources();
      currentSources = updated;
      return { triggered: true, sources: updated };
    } finally {
      isRefreshing = false;
      cooldownUntil = Date.now() + 10000;
    }
  }

  function getStatus() {
    return {
      isRefreshing,
      inCooldown: Date.now() < cooldownUntil,
      remainingCooldownMs: Math.max(0, cooldownUntil - Date.now()),
      sources: currentSources,
    };
  }

  return {
    handleManualRefresh,
    getStatus,
  };
}

/**
 * Model of the preview AI usage snapshot control in bot.js.
 */
function createMockUsageController(fetchUsage: () => Promise<{ used: number; limit: number }>) {
  let isChecking = false;
  let cooldownUntil = 0;
  let snapshot: { used: number; limit: number } | null = null;

  async function handleCheckUsage() {
    if (isChecking || Date.now() < cooldownUntil) {
      return { triggered: false, reason: isChecking ? 'in_flight' : 'cooldown' };
    }

    isChecking = true;
    try {
      snapshot = await fetchUsage();
      return { triggered: true, snapshot };
    } finally {
      isChecking = false;
      cooldownUntil = Date.now() + 10000;
    }
  }

  function getSnapshot() {
    return snapshot;
  }

  function getStatus() {
    return {
      isChecking,
      inCooldown: Date.now() < cooldownUntil,
      remainingCooldownMs: Math.max(0, cooldownUntil - Date.now()),
    };
  }

  return {
    handleCheckUsage,
    getSnapshot,
    getStatus,
  };
}

describe('Frontend Manual Refresh & Zero-Polling Logic', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Smart Enrichment Manual Refresh', () => {
    it('does NOT create background interval timers or auto-poll on load', () => {
      const fetchSources = jest.fn<() => Promise<any[]>>();
      // Even with pending sources, no background fetch is triggered
      createMockEnrichmentController([{ id: 1, enrichment_status: 'queued' }], fetchSources);

      // Fast-forward 60 seconds
      jest.advanceTimersByTime(60000);

      expect(fetchSources).not.toHaveBeenCalled();
    });

    it('performs exactly one request when manually clicked', async () => {
      const fetchSources = jest.fn<() => Promise<any[]>>().mockResolvedValue([
        { id: 1, enrichment_status: 'completed' },
      ]);
      const controller = createMockEnrichmentController([{ id: 1, enrichment_status: 'processing' }], fetchSources);

      const result = await controller.handleManualRefresh();
      expect(result.triggered).toBe(true);
      expect(fetchSources).toHaveBeenCalledTimes(1);
      expect(controller.getStatus().sources[0].enrichment_status).toBe('completed');
    });

    it('enforces a 10-second cooldown preventing repeated requests', async () => {
      const fetchSources = jest.fn<() => Promise<any[]>>().mockResolvedValue([
        { id: 1, enrichment_status: 'completed' },
      ]);
      const controller = createMockEnrichmentController([{ id: 1, enrichment_status: 'processing' }], fetchSources);

      // 1st click: succeeds
      await controller.handleManualRefresh();
      expect(fetchSources).toHaveBeenCalledTimes(1);
      expect(controller.getStatus().inCooldown).toBe(true);

      // 2nd click immediately: blocked by cooldown
      const secondClick = await controller.handleManualRefresh();
      expect(secondClick.triggered).toBe(false);
      expect(secondClick.reason).toBe('cooldown');
      expect(fetchSources).toHaveBeenCalledTimes(1);

      // Advance 5 seconds: still in cooldown
      jest.advanceTimersByTime(5000);
      const intermediateClick = await controller.handleManualRefresh();
      expect(intermediateClick.triggered).toBe(false);
      expect(fetchSources).toHaveBeenCalledTimes(1);

      // Advance 5 more seconds (total 10s): cooldown expires
      jest.advanceTimersByTime(5000);
      expect(controller.getStatus().inCooldown).toBe(false);

      // 3rd click after 10s: succeeds and triggers exactly 1 more request
      const thirdClick = await controller.handleManualRefresh();
      expect(thirdClick.triggered).toBe(true);
      expect(fetchSources).toHaveBeenCalledTimes(2);
    });
  });

  describe('Preview AI Usage Snapshot Control', () => {
    it('shows no usage snapshot initially until explicitly checked', () => {
      const fetchUsage = jest.fn<() => Promise<{ used: number; limit: number }>>();
      const controller = createMockUsageController(fetchUsage);

      expect(controller.getSnapshot()).toBeNull();
      expect(fetchUsage).not.toHaveBeenCalled();
    });

    it('fetches server state on manual check and renders snapshot', async () => {
      const fetchUsage = jest.fn<() => Promise<{ used: number; limit: number }>>().mockResolvedValue({
        used: 37,
        limit: 100,
      });
      const controller = createMockUsageController(fetchUsage);

      const res = await controller.handleCheckUsage();
      expect(res.triggered).toBe(true);
      expect(fetchUsage).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot()).toEqual({ used: 37, limit: 100 });
    });

    it('enforces 10-second cooldown on usage check button', async () => {
      const fetchUsage = jest.fn<() => Promise<{ used: number; limit: number }>>().mockResolvedValue({
        used: 2,
        limit: 100,
      });
      const controller = createMockUsageController(fetchUsage);

      // First check
      await controller.handleCheckUsage();
      expect(fetchUsage).toHaveBeenCalledTimes(1);
      expect(controller.getStatus().inCooldown).toBe(true);

      // Rapid follow-up click is blocked
      const blockedRes = await controller.handleCheckUsage();
      expect(blockedRes.triggered).toBe(false);
      expect(blockedRes.reason).toBe('cooldown');
      expect(fetchUsage).toHaveBeenCalledTimes(1);

      // After 10 seconds: cooldown clears
      jest.advanceTimersByTime(10000);
      expect(controller.getStatus().inCooldown).toBe(false);

      // Check again
      const allowedRes = await controller.handleCheckUsage();
      expect(allowedRes.triggered).toBe(true);
      expect(fetchUsage).toHaveBeenCalledTimes(2);
    });
  });
});
