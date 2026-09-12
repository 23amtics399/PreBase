import { describe, it, expect } from '@jest/globals';

describe('UI Knowledge Limits & 1-Bot State Logic', () => {
  const MAX_SOURCES = 2;
  const MAX_UPLOAD_BYTES = 10 * 1024; // 10 KB
  const MAX_TEXT_CHARS = 2000;
  const MAX_INSTRUCTION_CHARS = 2000;

  // ---------------------------------------------------------------------------
  // 1. Dashboard 1-Bot Limit State
  // ---------------------------------------------------------------------------
  describe('Dashboard 1-Bot Limit UI State', () => {
    function computeDashboardState(bots: { id: string; name: string }[]) {
      const atLimit = bots.length >= 1;
      return {
        createButtonDisabled: atLimit,
        createButtonTitle: atLimit
          ? 'You have reached the limit of 1 chatbot per account.'
          : null,
        badgeVisible: atLimit,
        badgeText: atLimit ? '1/1 Bot Used' : null,
      };
    }

    it('enables Create Bot action when user has 0 bots', () => {
      const state = computeDashboardState([]);
      expect(state.createButtonDisabled).toBe(false);
      expect(state.createButtonTitle).toBeNull();
      expect(state.badgeVisible).toBe(false);
    });

    it('disables Create Bot action and displays 1/1 limit badge when user has 1 bot', () => {
      const state = computeDashboardState([{ id: 'bot-1', name: 'Support Bot' }]);
      expect(state.createButtonDisabled).toBe(true);
      expect(state.createButtonTitle).toContain('limit of 1 chatbot per account');
      expect(state.badgeVisible).toBe(true);
      expect(state.badgeText).toBe('1/1 Bot Used');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Knowledge Base Slot Management & Disabling Logic
  // ---------------------------------------------------------------------------
  describe('Knowledge Base Slot Management & Input Locking', () => {
    function computeKBState(sources: { id: number; byte_size: number; source_type: 'file' | 'text' }[]) {
      const usedSlots = sources.length;
      const remainingSlots = Math.max(0, MAX_SOURCES - usedSlots);
      const atLimit = usedSlots >= MAX_SOURCES;
      const pct = Math.min(100, Math.round((usedSlots / MAX_SOURCES) * 100));

      return {
        usedSlots,
        remainingSlots,
        atLimit,
        progressBarPct: pct,
        label: `${usedSlots} / ${MAX_SOURCES} knowledge sources used (${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} remaining)`,
        fileUploadEnabled: !atLimit,
        directTextEnabled: !atLimit,
        limitBannerVisible: atLimit,
      };
    }

    it('shows 0/2 slots used with both inputs enabled on empty knowledge', () => {
      const state = computeKBState([]);
      expect(state.usedSlots).toBe(0);
      expect(state.remainingSlots).toBe(2);
      expect(state.atLimit).toBe(false);
      expect(state.fileUploadEnabled).toBe(true);
      expect(state.directTextEnabled).toBe(true);
      expect(state.limitBannerVisible).toBe(false);
      expect(state.label).toBe('0 / 2 knowledge sources used (2 slots remaining)');
    });

    it('shows 1/2 slots used with 1 remaining slot when 1 file is uploaded', () => {
      const state = computeKBState([{ id: 1, byte_size: 5000, source_type: 'file' }]);
      expect(state.usedSlots).toBe(1);
      expect(state.remainingSlots).toBe(1);
      expect(state.atLimit).toBe(false);
      expect(state.fileUploadEnabled).toBe(true);
      expect(state.directTextEnabled).toBe(true);
      expect(state.limitBannerVisible).toBe(false);
      expect(state.label).toBe('1 / 2 knowledge sources used (1 slot remaining)');
    });

    it('shows 1/2 slots used with 1 remaining slot when 1 direct-text is added', () => {
      const state = computeKBState([{ id: 1, byte_size: 1500, source_type: 'text' }]);
      expect(state.usedSlots).toBe(1);
      expect(state.remainingSlots).toBe(1);
      expect(state.atLimit).toBe(false);
      expect(state.fileUploadEnabled).toBe(true);
      expect(state.directTextEnabled).toBe(true);
    });

    it('locks both file upload and direct text when 2 files are added (2/2 limit reached)', () => {
      const state = computeKBState([
        { id: 1, byte_size: 4000, source_type: 'file' },
        { id: 2, byte_size: 6000, source_type: 'file' },
      ]);
      expect(state.usedSlots).toBe(2);
      expect(state.remainingSlots).toBe(0);
      expect(state.atLimit).toBe(true);
      expect(state.fileUploadEnabled).toBe(false);
      expect(state.directTextEnabled).toBe(false);
      expect(state.limitBannerVisible).toBe(true);
      expect(state.label).toBe('2 / 2 knowledge sources used (0 slots remaining)');
    });

    it('locks both inputs when 1 file + 1 direct-text are added (2/2 limit reached)', () => {
      const state = computeKBState([
        { id: 1, byte_size: 4000, source_type: 'file' },
        { id: 2, byte_size: 1800, source_type: 'text' },
      ]);
      expect(state.usedSlots).toBe(2);
      expect(state.remainingSlots).toBe(0);
      expect(state.atLimit).toBe(true);
      expect(state.fileUploadEnabled).toBe(false);
      expect(state.directTextEnabled).toBe(false);
      expect(state.limitBannerVisible).toBe(true);
    });

    it('locks both inputs when 2 direct-text sources are added (2/2 limit reached)', () => {
      const state = computeKBState([
        { id: 1, byte_size: 1200, source_type: 'text' },
        { id: 2, byte_size: 1900, source_type: 'text' },
      ]);
      expect(state.usedSlots).toBe(2);
      expect(state.remainingSlots).toBe(0);
      expect(state.atLimit).toBe(true);
      expect(state.fileUploadEnabled).toBe(false);
      expect(state.directTextEnabled).toBe(false);
      expect(state.limitBannerVisible).toBe(true);
    });

    it('re-enables both inputs when a source is deleted from a full 2-source state', () => {
      let sources: { id: number; byte_size: number; source_type: 'file' | 'text' }[] = [
        { id: 1, byte_size: 4000, source_type: 'file' },
        { id: 2, byte_size: 1800, source_type: 'text' },
      ];
      expect(computeKBState(sources).atLimit).toBe(true);

      // User deletes source 1
      sources = sources.filter(s => s.id !== 1);
      const updatedState = computeKBState(sources);
      expect(updatedState.usedSlots).toBe(1);
      expect(updatedState.remainingSlots).toBe(1);
      expect(updatedState.atLimit).toBe(false);
      expect(updatedState.fileUploadEnabled).toBe(true);
      expect(updatedState.directTextEnabled).toBe(true);
      expect(updatedState.limitBannerVisible).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Client-Side Input Validations
  // ---------------------------------------------------------------------------
  describe('Client-Side Input Validations', () => {
    function validateUpload(file: { name: string; size: number }, currentSourceCount: number) {
      if (currentSourceCount >= MAX_SOURCES) {
        return { valid: false, error: 'Maximum of 2 knowledge sources reached.' };
      }
      const ext = file.name.toLowerCase();
      if (!ext.endsWith('.txt') && !ext.endsWith('.md')) {
        return { valid: false, error: 'Only .txt and .md files are supported.' };
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return { valid: false, error: `File exceeds 10 KB limit (${(file.size / 1024).toFixed(1)} KB).` };
      }
      return { valid: true, error: null };
    }

    function validateDirectText(text: string, currentSourceCount: number) {
      if (currentSourceCount >= MAX_SOURCES) {
        return { valid: false, error: 'Maximum of 2 knowledge sources reached.' };
      }
      if (!text || text.trim().length === 0) {
        return { valid: false, error: 'Please enter text content.' };
      }
      if (text.length > MAX_TEXT_CHARS) {
        return { valid: false, error: `Knowledge text must not exceed ${MAX_TEXT_CHARS} characters per source.` };
      }
      return { valid: true, error: null };
    }

    function validateInstructions(prompt: string) {
      if (prompt.length > MAX_INSTRUCTION_CHARS) {
        return { valid: false, error: `Instructions must not exceed ${MAX_INSTRUCTION_CHARS} characters.` };
      }
      return { valid: true, error: null };
    }

    it('accepts file exactly 10 KB (10,240 bytes)', () => {
      const res = validateUpload({ name: 'docs.txt', size: 10240 }, 0);
      expect(res.valid).toBe(true);
    });

    it('rejects file larger than 10 KB (10,241 bytes)', () => {
      const res = validateUpload({ name: 'docs.txt', size: 10241 }, 0);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('exceeds 10 KB');
    });

    it('rejects unsupported file extension', () => {
      const res = validateUpload({ name: 'docs.pdf', size: 2000 }, 0);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Only .txt and .md');
    });

    it('rejects upload when 2 sources already exist', () => {
      const res = validateUpload({ name: 'docs.txt', size: 2000 }, 2);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Maximum of 2 knowledge sources reached');
    });

    it('accepts direct text of exactly 2,000 characters', () => {
      const res = validateDirectText('A'.repeat(2000), 0);
      expect(res.valid).toBe(true);
    });

    it('rejects direct text exceeding 2,000 characters (2,001 characters)', () => {
      const res = validateDirectText('A'.repeat(2001), 0);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('must not exceed 2000 characters');
    });

    it('rejects empty direct text', () => {
      const res = validateDirectText('   ', 0);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('enter text content');
    });

    it('rejects direct text when 2 sources already exist', () => {
      const res = validateDirectText('Some policy content', 2);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Maximum of 2 knowledge sources reached');
    });

    it('accepts instructions of exactly 2,000 characters', () => {
      const res = validateInstructions('I'.repeat(2000));
      expect(res.valid).toBe(true);
    });

    it('rejects instructions exceeding 2,000 characters (2,001 characters)', () => {
      const res = validateInstructions('I'.repeat(2001));
      expect(res.valid).toBe(false);
      expect(res.error).toContain('must not exceed 2000 characters');
    });
  });
});
