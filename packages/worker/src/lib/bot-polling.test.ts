import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// A conceptual model of the bot.js polling logic we just fixed
function createMockBotView(initialSources: any[], fetchSources: () => Promise<any[]>) {
  let pollTimer: any = null;
  let isUnmounted = false;

  const knowledgeSection: any = {};
  const isPending = (s: any) => s.enrichment_status === 'queued' || s.enrichment_status === 'processing';

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollEnrichmentStatus() {
    if (isUnmounted) {
      stopPolling();
      return;
    }
    const updated = await fetchSources();
    if (!updated.some(isPending)) {
      stopPolling();
    }
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(pollEnrichmentStatus, 5000);
  }

  // Initial load
  if (initialSources.some(isPending)) {
    startPolling();
  }

  knowledgeSection._startPolling = startPolling;

  function navigateAway() {
    isUnmounted = true;
  }

  return {
    knowledgeSection,
    navigateAway,
    getTimer: () => pollTimer,
    triggerPoll: pollEnrichmentStatus,
    stopPolling,
  };
}

describe('Frontend Polling Logic (Conceptual)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('starts polling on load if pending sources exist', () => {
    const fetchSources = jest.fn();
    const view = createMockBotView([{ enrichment_status: 'queued' }], fetchSources as any);
    expect(view.getTimer()).not.toBeNull();
  });

  it('does not start polling on load if no pending sources', () => {
    const fetchSources = jest.fn();
    const view = createMockBotView([{ enrichment_status: 'completed' }], fetchSources as any);
    expect(view.getTimer()).toBeNull();
  });

  it('can start polling later (e.g. after upload)', () => {
    const fetchSources = jest.fn();
    const view = createMockBotView([], fetchSources as any);
    
    view.knowledgeSection._startPolling();
    expect(view.getTimer()).not.toBeNull();
  });

  it('does not create multiple intervals if startPolling is called repeatedly', () => {
    const fetchSources = jest.fn();
    const view = createMockBotView([], fetchSources as any);
    
    view.knowledgeSection._startPolling();
    const timer1 = view.getTimer();
    view.knowledgeSection._startPolling();
    const timer2 = view.getTimer();
    
    expect(timer1).toBe(timer2);
  });

  it('stops polling when fetch returns no pending sources', async () => {
    const fetchSources = jest.fn<() => Promise<any[]>>().mockResolvedValue([{ enrichment_status: 'completed' }]);
    const view = createMockBotView([{ enrichment_status: 'queued' }], fetchSources as any);
    
    await view.triggerPoll();
    expect(view.getTimer()).toBeNull();
  });

  it('stops polling if user navigates away (isUnmounted)', async () => {
    const fetchSources = jest.fn();
    const view = createMockBotView([{ enrichment_status: 'queued' }], fetchSources as any);
    
    view.navigateAway();
    await view.triggerPoll(); // Next tick
    
    expect(view.getTimer()).toBeNull();
    expect(fetchSources).not.toHaveBeenCalled();
  });
});
