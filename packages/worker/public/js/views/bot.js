/**
 * Bot editor view — all sections: info, instructions, knowledge, preview, publish.
 * XSS safety: all user/AI content rendered via textContent or safe DOM APIs.
 */

import {
  getBot, updateBot, deleteBot,
  getKnowledge, uploadKnowledge, deleteKnowledge, addTextKnowledge,
  previewChat, publishBot, unpublishBot,
  getMenuItems, updateMenuSettings, createMenuItem, updateMenuItem, deleteMenuItem,
} from '../api.js?v=5';
import { showToast } from '../app.js';

// Production domain for share/embed links
const PROD_DOMAIN = 'https://prebase.sji.one';

// KB & Bot limits (mirrors server architecture — displayed for UX only; server is authoritative)
const MAX_SOURCES = 2;
const MAX_UPLOAD_BYTES = 10 * 1024; // 10 KB per file
const MAX_TEXT_CHARS = 2000; // 2,000 characters per direct text source
const MAX_INSTRUCTION_CHARS = 2000; // 2,000 characters for system prompt/instructions
const MAX_MENU_ITEMS = 8;
const MAX_MENU_LABEL_CHARS = 40;
const MAX_MENU_RESPONSE_CHARS = 1000;

export async function renderBot(container, botId, navigate) {
  container.innerHTML = '';

  // Back button
  const backBtn = document.createElement('button');
  backBtn.className = 'page-back';
  backBtn.setAttribute('aria-label', 'Back to dashboard');
  backBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12"></line>
      <polyline points="12 19 5 12 12 5"></polyline>
    </svg>
  `;
  const backText = document.createTextNode('All Bots');
  backBtn.appendChild(backText);
  backBtn.addEventListener('click', () => navigate('dashboard'));
  container.appendChild(backBtn);

  // Loading
  const loadingEl = document.createElement('div');
  loadingEl.className = 'app-loading';
  loadingEl.style.minHeight = '300px';
  loadingEl.innerHTML = `<div class="spinner" aria-hidden="true"></div><span>Loading bot…</span>`;
  container.appendChild(loadingEl);

  // Fetch bot, knowledge, and quick answers in parallel
  const [botRes, kbRes, menuRes] = await Promise.all([
    getBot(botId),
    getKnowledge(botId),
    getMenuItems(botId)
  ]);

  if (!botRes.ok) {
    loadingEl.remove();
    if (botRes.status === 401) { navigate('login'); return; }
    if (botRes.status === 404) { showToast('Bot not found.', 'error'); navigate('dashboard'); return; }
    const err = document.createElement('div');
    err.className = 'alert alert-danger';
    err.textContent = botRes.error;
    container.appendChild(err);
    return;
  }

  loadingEl.remove();
  const bot = botRes.data;
  const sources = kbRes.ok ? (kbRes.data?.sources || []) : [];
  const initialMenuItems = menuRes.ok ? (menuRes.data?.items || []) : [];
  const initialQuickAnswersEnabled = menuRes.ok
    ? !!menuRes.data?.quick_answers_enabled
    : (bot.quick_answers_enabled === 1);

  // Page header
  const header = document.createElement('div');
  header.className = 'page-header';
  const h1 = document.createElement('h1');
  h1.id = 'bot-page-title';
  h1.textContent = bot.name; // XSS safe
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger btn-sm';
  deleteBtn.id = 'delete-bot-btn';
  deleteBtn.textContent = 'Delete Bot';
  header.appendChild(h1);
  header.appendChild(deleteBtn);
  container.appendChild(header);

  // Render all sections
  container.appendChild(buildBasicInfoSection(bot, h1));
  container.appendChild(buildInstructionsSection(bot));
  const knowledgeSection = buildKnowledgeSection(bot, sources, container);
  container.appendChild(knowledgeSection);
  container.appendChild(buildQuickAnswersSection(bot, initialMenuItems, initialQuickAnswersEnabled));
  container.appendChild(buildPreviewSection(bot));
  container.appendChild(buildPublishSection(bot, navigate));

  // Delete bot
  deleteBtn.addEventListener('click', () => openDeleteBotModal(bot, navigate));

  // ── Enrichment status polling ──────────────────────────────────────────────
  // Polls every 4 seconds while any source is queued/processing.
  // Stops automatically when all sources reach a terminal state, or the
  // container leaves the DOM (user navigated away). Guard prevents double-start.
  // Called at initial render AND after each enriched upload so status updates
  // appear without a manual page refresh.
  const POLL_INTERVAL_MS = 4000;
  const isPending = s => s.enrichment_status === 'queued' || s.enrichment_status === 'processing';
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollEnrichmentStatus() {
    if (!document.contains(container)) { stopPolling(); return; }

    const res = await getKnowledge(botId);
    if (!res.ok) return; // transient failure — keep polling

    const updated = res.data?.sources || [];
    knowledgeSection._refreshSources?.(updated);

    if (!updated.some(isPending)) stopPolling();
  }

  function startPolling() {
    // Already running — skip
    if (pollTimer !== null) return;
    pollTimer = setInterval(pollEnrichmentStatus, POLL_INTERVAL_MS);
  }

  // Start polling immediately if sources are pending on load
  if (sources.some(isPending)) {
    startPolling();
  }

  // Expose startPolling so upload handler can trigger it after upload
  knowledgeSection._startPolling = startPolling;
}

// ==========================================================================
// SECTION 1: Basic Information
// ==========================================================================
function buildBasicInfoSection(bot, titleEl) {
  const section = document.createElement('div');
  section.className = 'section';

  const hdr = document.createElement('div');
  hdr.className = 'section-header';
  const titleDiv = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = 'Basic Information';
  titleDiv.appendChild(t);
  hdr.appendChild(titleDiv);
  section.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'section-body';

  // Name field
  const nameGroup = document.createElement('div');
  nameGroup.className = 'form-group';
  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'bot-name';
  nameLabel.textContent = 'Bot Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'bot-name';
  nameInput.className = 'input';
  nameInput.maxLength = 100;
  nameInput.value = bot.name; // safe — .value not innerHTML
  nameGroup.appendChild(nameLabel);
  nameGroup.appendChild(nameInput);

  // Desc field
  const descGroup = document.createElement('div');
  descGroup.className = 'form-group';
  const descLabel = document.createElement('label');
  descLabel.htmlFor = 'bot-desc';
  descLabel.textContent = 'Description';
  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.id = 'bot-desc';
  descInput.className = 'input';
  descInput.maxLength = 500;
  descInput.value = bot.description || ''; // safe
  const descHint = document.createElement('div');
  descHint.className = 'form-hint';
  descHint.textContent = 'Shown to users browsing your chatbot. Max 500 characters.';
  descGroup.appendChild(descLabel);
  descGroup.appendChild(descInput);
  descGroup.appendChild(descHint);

  // Save row
  const saveRow = buildSaveRow('info-save-status', async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('Bot name cannot be empty.', 'error'); return null; }
    const res = await updateBot(bot.id, { name, description: descInput.value.trim() });
    if (res.ok) {
      bot.name = name;
      bot.description = descInput.value.trim();
      titleEl.textContent = name; // Update page title safely
    }
    return res;
  });

  body.appendChild(nameGroup);
  body.appendChild(descGroup);
  body.appendChild(saveRow);
  section.appendChild(body);
  return section;
}

// ==========================================================================
// SECTION 2: AI Instructions
// ==========================================================================
function buildInstructionsSection(bot) {
  const section = document.createElement('div');
  section.className = 'section';

  const hdr = document.createElement('div');
  hdr.className = 'section-header';
  const titleDiv = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = 'AI Instructions';
  const sub = document.createElement('div');
  sub.className = 'section-subtitle';
  sub.textContent = 'Tell your bot how it should behave, what role it has, and what it should or should not do.';
  titleDiv.appendChild(t);
  titleDiv.appendChild(sub);
  hdr.appendChild(titleDiv);
  section.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'section-body';

  // Info notice — clarifies that instructions do not consume a knowledge slot
  const notice = document.createElement('div');
  notice.className = 'alert alert-info';
  notice.style.marginBottom = '16px';
  notice.textContent = 'Instructions guide your bot\'s role, tone, and behavioral constraints (maximum 2,000 characters). They do NOT consume a knowledge-source slot and should not contain reference documents or FAQs (add those in the Knowledge section below).';

  const promptGroup = document.createElement('div');
  promptGroup.className = 'form-group';
  const promptLabel = document.createElement('label');
  promptLabel.htmlFor = 'bot-prompt';
  promptLabel.textContent = 'System Instructions';
  const promptInput = document.createElement('textarea');
  promptInput.id = 'bot-prompt';
  promptInput.className = 'input';
  promptInput.style.minHeight = '140px';
  promptInput.maxLength = MAX_INSTRUCTION_CHARS;
  promptInput.placeholder =
    'Example: "You are a friendly support assistant for Acme Inc. Help users with product questions. Politely decline questions unrelated to Acme products. Always suggest contacting support@acme.com for billing issues."';
  promptInput.value = bot.system_prompt || ''; // safe — .value

  const charCount = document.createElement('div');
  charCount.className = 'char-count';
  charCount.id = 'instructions-char-count';
  charCount.textContent = `${(bot.system_prompt || '').length} / ${MAX_INSTRUCTION_CHARS} characters`;
  promptInput.addEventListener('input', () => {
    charCount.textContent = `${promptInput.value.length} / ${MAX_INSTRUCTION_CHARS} characters`;
  });

  promptGroup.appendChild(promptLabel);
  promptGroup.appendChild(promptInput);
  promptGroup.appendChild(charCount);

  const saveRow = buildSaveRow('instructions-save-status', async () => {
    if (promptInput.value.length > MAX_INSTRUCTION_CHARS) {
      showToast(`Instructions must not exceed ${MAX_INSTRUCTION_CHARS} characters.`, 'error');
      return null;
    }
    return await updateBot(bot.id, { system_prompt: promptInput.value.trim() });
  });

  body.appendChild(notice);
  body.appendChild(promptGroup);
  body.appendChild(saveRow);
  section.appendChild(body);
  return section;
}

// ==========================================================================
// SECTION 3: Knowledge Management
// ==========================================================================
function buildKnowledgeSection(bot, initialSources, pageContainer) {
  const section = document.createElement('div');
  section.className = 'section';

  const hdr = document.createElement('div');
  hdr.className = 'section-header';
  const titleDiv = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = 'Knowledge';
  const sub = document.createElement('div');
  sub.className = 'section-subtitle';
  sub.textContent = 'Add up to 2 knowledge sources total using any combination of uploaded files (up to 10 KB each) and direct-text sources (up to 2,000 characters each).';
  titleDiv.appendChild(t);
  titleDiv.appendChild(sub);
  hdr.appendChild(titleDiv);
  section.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'section-body';

  // Privacy warning — always visible, not in a tooltip
  const warning = document.createElement('div');
  warning.className = 'privacy-warning';
  const warnTitle = document.createElement('div');
  warnTitle.className = 'privacy-warning-title';
  warnTitle.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
      <line x1="12" y1="9" x2="12" y2="13"></line>
      <line x1="12" y1="17" x2="12.01" y2="17"></line>
    </svg>
  `;
  const warnTitleText = document.createTextNode("Don't upload private or sensitive information.");
  warnTitle.appendChild(warnTitleText);

  const warnList = document.createElement('ul');
  [
    'Passwords or API keys',
    'Payment information or financial records',
    'Government IDs or personal identification numbers',
    'Medical or health records',
    'Private customer information',
    'Confidential business information',
  ].forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    warnList.appendChild(li);
  });

  const warnNote = document.createElement('p');
  warnNote.textContent = 'Only upload information you are authorised to use in this chatbot. Public bots will use this knowledge when answering visitor questions.';

  warning.appendChild(warnTitle);
  warning.appendChild(warnList);
  warning.appendChild(warnNote);
  body.appendChild(warning);

  // Usage summary (slots used / remaining)
  const usageSummaryEl = document.createElement('div');
  body.appendChild(usageSummaryEl);

  // Limit reached alert banner (shown when 2/2 slots used)
  const limitBanner = document.createElement('div');
  limitBanner.className = 'alert alert-info';
  limitBanner.id = 'kb-limit-banner';
  limitBanner.style.display = 'none';
  limitBanner.style.marginBottom = '16px';
  limitBanner.textContent = 'Maximum 2 knowledge sources reached. Delete an existing source below if you need to add another file or direct-text source.';
  body.appendChild(limitBanner);

  // Two-column input container
  const inputGrid = document.createElement('div');
  inputGrid.style.display = 'grid';
  inputGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(300px, 1fr))';
  inputGrid.style.gap = '16px';
  inputGrid.style.marginBottom = '20px';

  // --------------------------------------------------------------------------
  // Panel A: File Upload (Max 10 KB per file)
  // --------------------------------------------------------------------------
  const uploadCard = document.createElement('div');
  uploadCard.className = 'card';
  uploadCard.style.padding = '16px';
  uploadCard.style.display = 'flex';
  uploadCard.style.flexDirection = 'column';

  const uploadCardTitle = document.createElement('div');
  uploadCardTitle.style.display = 'flex';
  uploadCardTitle.style.justifyContent = 'space-between';
  uploadCardTitle.style.alignItems = 'center';
  uploadCardTitle.style.marginBottom = '4px';

  const uploadTitleText = document.createElement('span');
  uploadTitleText.style.fontWeight = '600';
  uploadTitleText.style.fontSize = '0.9rem';
  uploadTitleText.textContent = 'Upload File (.txt, .md)';

  const uploadLimitBadge = document.createElement('span');
  uploadLimitBadge.className = 'badge badge-warning';
  uploadLimitBadge.textContent = 'Max 10 KB each';
  uploadCardTitle.appendChild(uploadTitleText);
  uploadCardTitle.appendChild(uploadLimitBadge);

  const uploadCardHint = document.createElement('div');
  uploadCardHint.className = 'form-hint';
  uploadCardHint.style.marginBottom = '12px';
  uploadCardHint.textContent = 'Upload a plain text or markdown document (consumes 1 of your 2 knowledge slots).';

  const uploadZone = document.createElement('div');
  uploadZone.className = 'upload-zone';
  uploadZone.id = 'upload-zone';
  uploadZone.setAttribute('role', 'button');
  uploadZone.setAttribute('tabindex', '0');
  uploadZone.setAttribute('aria-label', 'Upload knowledge file (max 10 KB)');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.txt,.md';
  fileInput.id = 'knowledge-file-input';
  fileInput.setAttribute('aria-label', 'Choose a .txt or .md file up to 10 KB');

  uploadZone.innerHTML = `
    <div class="upload-zone-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="16 16 12 12 8 16"></polyline>
        <line x1="12" y1="12" x2="12" y2="21"></line>
        <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"></path>
      </svg>
    </div>
    <div class="upload-zone-text">Click to upload or drag and drop</div>
    <div class="upload-zone-hint">Supported: .txt, .md — Maximum 10 KB</div>
  `;
  uploadZone.appendChild(fileInput);

  const uploadStatus = document.createElement('div');
  uploadStatus.style.marginTop = '8px';
  uploadStatus.style.fontSize = '0.8125rem';
  uploadStatus.id = 'upload-status';

  uploadCard.appendChild(uploadCardTitle);
  uploadCard.appendChild(uploadCardHint);
  uploadCard.appendChild(uploadZone);
  uploadCard.appendChild(uploadStatus);
  inputGrid.appendChild(uploadCard);

  // --------------------------------------------------------------------------
  // Panel B: Direct Text Input (Max 2,000 characters)
  // --------------------------------------------------------------------------
  const textCard = document.createElement('div');
  textCard.className = 'card';
  textCard.style.padding = '16px';
  textCard.style.display = 'flex';
  textCard.style.flexDirection = 'column';

  const textCardTitle = document.createElement('div');
  textCardTitle.style.display = 'flex';
  textCardTitle.style.justifyContent = 'space-between';
  textCardTitle.style.alignItems = 'center';
  textCardTitle.style.marginBottom = '4px';

  const textTitleText = document.createElement('span');
  textTitleText.style.fontWeight = '600';
  textTitleText.style.fontSize = '0.9rem';
  textTitleText.textContent = 'Add Direct Text';

  const textLimitBadge = document.createElement('span');
  textLimitBadge.className = 'badge badge-warning';
  textLimitBadge.textContent = 'Max 2,000 chars each';
  textCardTitle.appendChild(textTitleText);
  textCardTitle.appendChild(textLimitBadge);

  const textCardHint = document.createElement('div');
  textCardHint.className = 'form-hint';
  textCardHint.style.marginBottom = '12px';
  textCardHint.textContent = 'Type or paste knowledge text directly (consumes 1 of your 2 knowledge slots).';

  const textLabelInput = document.createElement('input');
  textLabelInput.type = 'text';
  textLabelInput.className = 'input';
  textLabelInput.id = 'direct-text-label';
  textLabelInput.placeholder = 'Title / Label (optional, e.g. Return Policy, FAQ)';
  textLabelInput.maxLength = 100;
  textLabelInput.style.marginBottom = '8px';

  const textInput = document.createElement('textarea');
  textInput.className = 'input';
  textInput.id = 'direct-text-content';
  textInput.placeholder = 'Paste or type factual information here…';
  textInput.maxLength = MAX_TEXT_CHARS;
  textInput.style.minHeight = '80px';
  textInput.style.resize = 'vertical';

  const textCharCount = document.createElement('div');
  textCharCount.className = 'char-count';
  textCharCount.id = 'direct-text-char-count';
  textCharCount.textContent = `0 / ${MAX_TEXT_CHARS} characters`;

  textInput.addEventListener('input', () => {
    textCharCount.textContent = `${textInput.value.length} / ${MAX_TEXT_CHARS} characters`;
  });

  const textActionRow = document.createElement('div');
  textActionRow.style.display = 'flex';
  textActionRow.style.justifyContent = 'space-between';
  textActionRow.style.alignItems = 'center';
  textActionRow.style.marginTop = '8px';

  const addTextBtn = document.createElement('button');
  addTextBtn.className = 'btn btn-secondary btn-sm';
  addTextBtn.id = 'add-text-btn';
  addTextBtn.textContent = '+ Add Text Source';

  textActionRow.appendChild(textCharCount);
  textActionRow.appendChild(addTextBtn);

  const textStatus = document.createElement('div');
  textStatus.style.marginTop = '8px';
  textStatus.style.fontSize = '0.8125rem';
  textStatus.id = 'text-status';

  textCard.appendChild(textCardTitle);
  textCard.appendChild(textCardHint);
  textCard.appendChild(textLabelInput);
  textCard.appendChild(textInput);
  textCard.appendChild(textActionRow);
  textCard.appendChild(textStatus);
  inputGrid.appendChild(textCard);
  body.appendChild(inputGrid);

  // Smart Enrichment Opt-in
  const enrichmentSection = document.createElement('div');
  enrichmentSection.className = 'enrichment-opt-in';
  enrichmentSection.style.marginTop = '16px';
  enrichmentSection.style.padding = '16px';
  enrichmentSection.style.border = '1px solid var(--neutral-300)';
  enrichmentSection.style.borderRadius = '8px';
  enrichmentSection.style.backgroundColor = 'var(--neutral-50)';

  const enrichLabel = document.createElement('label');
  enrichLabel.style.display = 'flex';
  enrichLabel.style.alignItems = 'flex-start';
  enrichLabel.style.gap = '8px';
  enrichLabel.style.cursor = 'pointer';

  const enrichCheckbox = document.createElement('input');
  enrichCheckbox.type = 'checkbox';
  enrichCheckbox.id = 'enrichment-checkbox';
  enrichCheckbox.style.marginTop = '4px';

  const enrichText = document.createElement('div');
  enrichText.innerHTML = `
    <strong style="display:block; margin-bottom: 4px;">Enable Smart Enrichment</strong>
    <p style="margin: 0 0 8px 0; font-size: 0.9rem; color: var(--neutral-700);">Use AI to analyze this document and improve how your bot finds relevant information. This sends the uploaded document content to a third-party AI service (Groq API) for processing.</p>
    <p style="margin: 0 0 8px 0; font-size: 0.9rem; color: var(--neutral-700);">Smart Enrichment generates search metadata such as possible questions, keywords, aliases, topics, and entities. Your original document remains the authoritative source used to generate answers.</p>
  `;

  enrichLabel.appendChild(enrichCheckbox);
  enrichLabel.appendChild(enrichText);
  enrichmentSection.appendChild(enrichLabel);

  const enrichPrivacy = document.createElement('div');
  enrichPrivacy.style.marginTop = '12px';
  enrichPrivacy.style.paddingTop = '12px';
  enrichPrivacy.style.borderTop = '1px solid var(--neutral-200)';
  enrichPrivacy.style.fontSize = '0.85rem';
  enrichPrivacy.style.color = 'var(--neutral-600)';
  enrichPrivacy.innerHTML = `<strong>Privacy notice:</strong> When Smart Enrichment is enabled, the uploaded document content is sent to a third-party AI service (Groq API) for processing. Do not enable this feature for passwords, credentials, personal data, medical information, financial information, confidential documents, or anything you are not authorized to send to a third-party AI service.`;
  enrichmentSection.appendChild(enrichPrivacy);

  body.appendChild(enrichmentSection);

  // Source list
  const sourceListEl = document.createElement('div');
  sourceListEl.className = 'source-list';
  sourceListEl.id = 'source-list';
  body.appendChild(sourceListEl);
  section.appendChild(body);

  // --- State ---
  let sources = [...initialSources];

  function refreshUsage() {
    usageSummaryEl.innerHTML = '';
    const usedSlots = sources.length;
    const remainingSlots = Math.max(0, MAX_SOURCES - usedSlots);
    const atLimit = usedSlots >= MAX_SOURCES;

    const labelRow = document.createElement('div');
    labelRow.className = 'usage-label';
    const leftLabel = document.createElement('span');
    leftLabel.id = 'kb-slots-used-text';
    leftLabel.textContent = `${usedSlots} / ${MAX_SOURCES} knowledge sources used (${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} remaining)`;
    const rightLabel = document.createElement('span');
    rightLabel.textContent = atLimit ? 'Limit reached (2/2)' : `${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} available`;
    labelRow.appendChild(leftLabel);
    labelRow.appendChild(rightLabel);

    const bar = document.createElement('div');
    bar.className = 'usage-bar';
    const fill = document.createElement('div');
    const pct = Math.min(100, Math.round((usedSlots / MAX_SOURCES) * 100));
    fill.className = 'usage-bar-fill' + (atLimit ? ' danger' : usedSlots === 1 ? ' warning' : '');
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    usageSummaryEl.appendChild(labelRow);
    usageSummaryEl.appendChild(bar);
    usageSummaryEl.style.marginBottom = '16px';
  }

  function refreshInputsState() {
    const atLimit = sources.length >= MAX_SOURCES;
    limitBanner.style.display = atLimit ? 'block' : 'none';

    // File upload
    uploadZone.style.opacity = atLimit ? '0.5' : '1';
    uploadZone.style.pointerEvents = atLimit ? 'none' : '';
    fileInput.disabled = atLimit;
    if (atLimit) {
      uploadZone.setAttribute('aria-disabled', 'true');
    } else {
      uploadZone.removeAttribute('aria-disabled');
    }

    // Direct text
    textInput.disabled = atLimit;
    textLabelInput.disabled = atLimit;
    addTextBtn.disabled = atLimit;
    if (atLimit) {
      addTextBtn.setAttribute('aria-disabled', 'true');
    } else {
      addTextBtn.removeAttribute('aria-disabled');
    }
  }

  function refreshSourceList() {
    sourceListEl.innerHTML = '';
    if (sources.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'form-hint';
      empty.style.textAlign = 'center';
      empty.style.padding = '12px 0';
      empty.textContent = 'No knowledge sources yet. Add up to 2 sources in any combination (2 files, 1 file + 1 text source, or 2 text sources) so your bot can answer questions about your content.';
      sourceListEl.appendChild(empty);
      return;
    }
    sources.forEach(src => {
      sourceListEl.appendChild(buildSourceItem(src));
    });
  }

  function buildSourceItem(src) {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.dataset.sourceId = src.id;

    const isText = src.source_type === 'text';
    const ext = isText ? 'TXT' : (src.filename || '').toLowerCase().endsWith('.md') ? 'MD' : 'TXT';
    const icon = document.createElement('div');
    icon.className = 'source-icon';
    icon.textContent = ext; // safe

    const info = document.createElement('div');
    info.className = 'source-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'source-name';
    nameEl.textContent = src.filename; // XSS safe

    const metaEl = document.createElement('div');
    metaEl.className = 'source-meta';
    
    let enrichStatusText = '';
    if (src.enrichment_status === 'queued' || src.enrichment_status === 'processing') {
      enrichStatusText = ' · Smart enrichment: Processing…';
    } else if (src.enrichment_status === 'completed') {
      enrichStatusText = ' · Smart enrichment: Complete';
    } else if (src.enrichment_status === 'partial') {
      enrichStatusText = ' · Smart enrichment: Partially complete (some chunks failed)';
    } else if (src.enrichment_status === 'failed') {
      enrichStatusText = ' · Smart enrichment: Failed. Your original knowledge is still available for normal search.';
    }

    const typeLabel = isText ? 'Direct text' : 'Uploaded file';
    metaEl.textContent = `${formatBytes(src.byte_size)} · ${src.chunk_count} chunk${src.chunk_count !== 1 ? 's' : ''} · ${typeLabel}${enrichStatusText}`;

    info.appendChild(nameEl);
    info.appendChild(metaEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm btn-icon';
    delBtn.setAttribute('aria-label', 'Delete ' + src.filename);
    delBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>`;
    delBtn.style.color = 'var(--danger-500)';

    delBtn.addEventListener('click', () => openDeleteSourceModal(src, async () => {
      const res = await deleteKnowledge(bot.id, src.id);
      if (!res.ok) { showToast(res.error, 'error'); return; }
      sources = sources.filter(s => s.id !== src.id);
      refreshUsage();
      refreshSourceList();
      refreshInputsState();
      showToast('Source deleted.', 'success');
    }));

    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(delBtn);
    return item;
  }

  // --- Upload handling ---
  async function handleUpload(file) {
    if (!file) return;

    if (sources.length >= MAX_SOURCES) {
      showUploadStatus('Maximum of 2 knowledge sources reached. Delete an existing source first.', 'error');
      return;
    }

    const name = file.name.toLowerCase();
    if (!name.endsWith('.txt') && !name.endsWith('.md')) {
      showUploadStatus("This file type isn't supported yet. Please upload a .txt or .md file.", 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showUploadStatus(`"${file.name}" exceeds the 10 KB maximum limit (${(file.size / 1024).toFixed(1)} KB). Please choose a file under 10 KB.`, 'error');
      return;
    }

    showUploadStatus('Uploading…', 'loading');
    uploadZone.style.pointerEvents = 'none';
    fileInput.disabled = true;

    const isEnrichmentEnabled = !!document.getElementById('enrichment-checkbox')?.checked;
    const res = await uploadKnowledge(bot.id, file, isEnrichmentEnabled);

    uploadZone.style.pointerEvents = '';
    fileInput.disabled = false;
    fileInput.value = '';

    if (!res.ok) {
      showUploadStatus(res.error, 'error');
      return;
    }

    sources.unshift(res.data);
    refreshUsage();
    refreshSourceList();
    refreshInputsState();
    showUploadStatus(`"${file.name}" uploaded successfully (${res.data.chunk_count} chunks).`, 'success');

    section._startPolling?.();
  }

  function showUploadStatus(msg, type) {
    uploadStatus.textContent = msg;
    uploadStatus.style.color = type === 'error' ? 'var(--danger-600)'
      : type === 'success' ? 'var(--success-600)'
      : 'var(--neutral-500)';
  }

  // --- Direct Text handling ---
  async function handleAddText() {
    const text = textInput.value;
    const label = textLabelInput.value;

    if (sources.length >= MAX_SOURCES) {
      showTextStatus('Maximum of 2 knowledge sources reached. Delete an existing source first.', 'error');
      return;
    }
    if (!text || text.trim().length === 0) {
      showTextStatus('Please enter some text content.', 'error');
      return;
    }
    if (text.length > MAX_TEXT_CHARS) {
      showTextStatus(`Knowledge text must not exceed ${MAX_TEXT_CHARS} characters per source.`, 'error');
      return;
    }

    showTextStatus('Saving text source…', 'loading');
    addTextBtn.disabled = true;
    textInput.disabled = true;
    textLabelInput.disabled = true;

    const res = await addTextKnowledge(bot.id, text.trim(), label.trim());

    addTextBtn.disabled = false;
    textInput.disabled = false;
    textLabelInput.disabled = false;

    if (!res.ok) {
      showTextStatus(res.error, 'error');
      return;
    }

    sources.unshift(res.data);
    refreshUsage();
    refreshSourceList();
    refreshInputsState();

    textInput.value = '';
    textLabelInput.value = '';
    textCharCount.textContent = `0 / ${MAX_TEXT_CHARS} characters`;
    showTextStatus('Text source added successfully.', 'success');
  }

  function showTextStatus(msg, type) {
    textStatus.textContent = msg;
    textStatus.style.color = type === 'error' ? 'var(--danger-600)'
      : type === 'success' ? 'var(--success-600)'
      : 'var(--neutral-500)';
  }

  // Event Listeners
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) handleUpload(fileInput.files[0]);
  });

  uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleUpload(file);
  });

  uploadZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  addTextBtn.addEventListener('click', handleAddText);

  // Initial render
  refreshUsage();
  refreshSourceList();
  refreshInputsState();

  // Expose a refresh hook for enrichment-status polling.
  section._refreshSources = function(newSources) {
    sources = newSources;
    refreshUsage();
    refreshSourceList();
    refreshInputsState();
  };

  return section;
}

// ==========================================================================
// SECTION 4: Quick Answers / Fallback Menu
// ==========================================================================
function buildQuickAnswersSection(bot, initialItems = [], initialEnabled = false) {
  const section = document.createElement('div');
  section.className = 'section';
  section.id = 'quick-answers-section';

  const hdr = document.createElement('div');
  hdr.className = 'section-header';
  const titleDiv = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = 'Quick Answers / Fallback Menu';
  const sub = document.createElement('div');
  sub.className = 'section-subtitle';
  sub.textContent = 'Configure owner-authored responses shown as interactive chips for visitors and as a guaranteed fallback when AI quota is exhausted.';
  titleDiv.appendChild(t);
  titleDiv.appendChild(sub);
  hdr.appendChild(titleDiv);
  section.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'section-body';

  // Explanatory Notice
  const notice = document.createElement('div');
  notice.className = 'alert alert-info';
  notice.style.marginBottom = '20px';
  notice.textContent =
    'Quick Answers provide instant, reliable replies written directly by you that consume zero AI quota. When your daily AI limit is reached, visitors are presented with these options so your chat widget is never left dead or unresponsive. PreBase provides the interface and tooling, but does not author or verify your response content.';
  body.appendChild(notice);

  // State
  let items = Array.isArray(initialItems) ? [...initialItems] : [];
  let isEnabled = !!initialEnabled;

  // Enable/Disable Toggle Card
  const toggleCard = document.createElement('div');
  toggleCard.className = 'quick-answers-toggle-card';

  const toggleInfo = document.createElement('div');
  toggleInfo.className = 'quick-answers-toggle-info';
  const toggleTitle = document.createElement('div');
  toggleTitle.className = 'quick-answers-toggle-title';
  toggleTitle.textContent = 'Enable Quick Answers in Chat Widget';
  const toggleDesc = document.createElement('div');
  toggleDesc.className = 'quick-answers-toggle-desc';
  toggleDesc.textContent =
    'When enabled, clickable chips appear above the message input during normal chat. When disabled, normal AI chat operates without chips, but your configured answers remain available as an automated fallback if daily AI quota is exhausted.';
  toggleInfo.appendChild(toggleTitle);
  toggleInfo.appendChild(toggleDesc);

  const toggleRight = document.createElement('div');
  toggleRight.style.display = 'flex';
  toggleRight.style.alignItems = 'center';
  toggleRight.style.gap = '12px';

  const statusBadge = document.createElement('span');
  function updateBadge() {
    statusBadge.className = isEnabled ? 'badge badge-public' : 'badge badge-private';
    statusBadge.innerHTML = `<span class="badge-dot" aria-hidden="true"></span>${isEnabled ? 'Active' : 'Disabled'}`;
  }
  updateBadge();

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'check-item';
  toggleLabel.style.margin = '0';
  toggleLabel.style.cursor = 'pointer';

  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.id = 'quick-answers-toggle';
  toggleInput.checked = isEnabled;
  toggleInput.setAttribute('aria-label', 'Toggle Quick Answers in widget');

  toggleInput.addEventListener('change', async () => {
    const desiredState = toggleInput.checked;
    toggleInput.disabled = true;
    const res = await updateMenuSettings(bot.id, desiredState);
    toggleInput.disabled = false;
    if (res.ok) {
      isEnabled = desiredState;
      bot.quick_answers_enabled = isEnabled ? 1 : 0;
      updateBadge();
      showToast(isEnabled ? 'Quick Answers enabled in widget.' : 'Quick Answers disabled in widget.', 'success');
    } else {
      toggleInput.checked = isEnabled; // revert
      showToast(res.error || 'Failed to update Quick Answers setting.', 'error');
    }
  });

  toggleLabel.appendChild(toggleInput);
  toggleRight.appendChild(statusBadge);
  toggleRight.appendChild(toggleLabel);
  toggleCard.appendChild(toggleInfo);
  toggleCard.appendChild(toggleRight);
  body.appendChild(toggleCard);

  // Header Row: Counter & Add Button
  const headerRow = document.createElement('div');
  headerRow.className = 'quick-answers-header-row';

  const headerLeft = document.createElement('div');
  headerLeft.style.display = 'flex';
  headerLeft.style.alignItems = 'center';
  headerLeft.style.gap = '10px';

  const listTitle = document.createElement('div');
  listTitle.style.fontWeight = '600';
  listTitle.style.fontSize = '0.9375rem';
  listTitle.style.color = 'var(--neutral-900)';
  listTitle.textContent = 'Configured Answers';

  const countBadge = document.createElement('span');
  countBadge.className = 'quick-answers-count-badge';
  countBadge.id = 'quick-answers-count-badge';

  headerLeft.appendChild(listTitle);
  headerLeft.appendChild(countBadge);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary btn-sm';
  addBtn.id = 'add-quick-answer-btn';
  addBtn.textContent = '+ Add Quick Answer';
  addBtn.addEventListener('click', () => {
    if (items.length >= MAX_MENU_ITEMS) {
      showToast(`Maximum of ${MAX_MENU_ITEMS} Quick Answers allowed.`, 'error');
      return;
    }
    openMenuItemModal(bot, null, (newItem) => {
      items.push(newItem);
      renderList();
    });
  });

  headerRow.appendChild(headerLeft);
  headerRow.appendChild(addBtn);
  body.appendChild(headerRow);

  // Items List Container
  const listContainer = document.createElement('div');
  listContainer.className = 'quick-answers-list';
  listContainer.id = 'quick-answers-list';
  body.appendChild(listContainer);

  function renderList() {
    listContainer.innerHTML = '';
    const count = items.length;
    countBadge.textContent = `${count} / ${MAX_MENU_ITEMS} configured`;
    addBtn.disabled = count >= MAX_MENU_ITEMS;

    if (count === 0) {
      const emptyCard = document.createElement('div');
      emptyCard.className = 'quick-answers-empty';
      emptyCard.id = 'quick-answers-empty';
      const emptyTitle = document.createElement('div');
      emptyTitle.className = 'quick-answers-empty-title';
      emptyTitle.textContent = 'No Quick Answers configured yet';
      const emptyDesc = document.createElement('div');
      emptyDesc.className = 'quick-answers-empty-desc';
      emptyDesc.textContent =
        'Add common questions (such as Shipping Info, Support Hours, or Return Policy) so visitors get immediate answers without consuming AI quota.';
      emptyCard.appendChild(emptyTitle);
      emptyCard.appendChild(emptyDesc);
      listContainer.appendChild(emptyCard);
      return;
    }

    // Sort by display_order
    items.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

    items.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'quick-answer-item-card';
      card.id = `quick-answer-item-${item.id}`;

      // Left main
      const mainDiv = document.createElement('div');
      mainDiv.className = 'quick-answer-item-main';

      const orderPill = document.createElement('span');
      orderPill.className = 'quick-answer-item-order';
      orderPill.textContent = `#${index + 1}`;

      const contentDiv = document.createElement('div');
      contentDiv.className = 'quick-answer-item-content';

      const labelEl = document.createElement('div');
      labelEl.className = 'quick-answer-item-label';
      labelEl.textContent = item.label;

      const responseEl = document.createElement('div');
      responseEl.className = 'quick-answer-item-response';
      responseEl.textContent = item.response;

      contentDiv.appendChild(labelEl);
      contentDiv.appendChild(responseEl);
      mainDiv.appendChild(orderPill);
      mainDiv.appendChild(contentDiv);

      // Right actions
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'quick-answer-item-actions';

      // Move Up button
      const upBtn = document.createElement('button');
      upBtn.className = 'btn btn-secondary btn-sm btn-move-up';
      upBtn.title = 'Move Up';
      upBtn.setAttribute('aria-label', `Move ${item.label} up`);
      upBtn.textContent = '↑';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', async () => {
        if (index === 0) return;
        const prev = items[index - 1];
        const newOrderCurrent = prev.display_order ?? (index - 1);
        const newOrderPrev = item.display_order ?? index;

        upBtn.disabled = true;
        item.display_order = newOrderCurrent;
        prev.display_order = newOrderPrev;
        items[index - 1] = item;
        items[index] = prev;
        renderList();

        await Promise.all([
          updateMenuItem(bot.id, item.id, { display_order: item.display_order }),
          updateMenuItem(bot.id, prev.id, { display_order: prev.display_order }),
        ]);
      });

      // Move Down button
      const downBtn = document.createElement('button');
      downBtn.className = 'btn btn-secondary btn-sm btn-move-down';
      downBtn.title = 'Move Down';
      downBtn.setAttribute('aria-label', `Move ${item.label} down`);
      downBtn.textContent = '↓';
      downBtn.disabled = index === items.length - 1;
      downBtn.addEventListener('click', async () => {
        if (index === items.length - 1) return;
        const next = items[index + 1];
        const newOrderCurrent = next.display_order ?? (index + 1);
        const newOrderNext = item.display_order ?? index;

        downBtn.disabled = true;
        item.display_order = newOrderCurrent;
        next.display_order = newOrderNext;
        items[index + 1] = item;
        items[index] = next;
        renderList();

        await Promise.all([
          updateMenuItem(bot.id, item.id, { display_order: item.display_order }),
          updateMenuItem(bot.id, next.id, { display_order: next.display_order }),
        ]);
      });

      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm btn-edit-answer';
      editBtn.textContent = 'Edit';
      editBtn.setAttribute('aria-label', `Edit ${item.label}`);
      editBtn.addEventListener('click', () => {
        openMenuItemModal(bot, item, (updatedItem) => {
          Object.assign(item, updatedItem);
          renderList();
        });
      });

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm btn-delete-answer';
      delBtn.textContent = 'Delete';
      delBtn.setAttribute('aria-label', `Delete ${item.label}`);
      delBtn.addEventListener('click', () => {
        openDeleteMenuItemModal(bot, item, () => {
          items = items.filter(x => x.id !== item.id);
          renderList();
        });
      });

      actionsDiv.appendChild(upBtn);
      actionsDiv.appendChild(downBtn);
      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(delBtn);

      card.appendChild(mainDiv);
      card.appendChild(actionsDiv);
      listContainer.appendChild(card);
    });
  }

  renderList();
  section.appendChild(body);
  return section;
}

function openMenuItemModal(bot, existingItem, onSaved) {
  const isEdit = !!existingItem;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.maxWidth = '560px';

  const hdr = document.createElement('div');
  hdr.className = 'modal-header';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.textContent = isEdit ? 'Edit Quick Answer' : 'Add Quick Answer';
  hdr.appendChild(title);

  const body = document.createElement('div');
  body.className = 'modal-body';

  const hint = document.createElement('div');
  hint.className = 'form-hint';
  hint.style.marginBottom = '16px';
  hint.textContent = 'Quick Answers are returned verbatim to visitors without consuming AI quota.';
  body.appendChild(hint);

  // Label group
  const labelGroup = document.createElement('div');
  labelGroup.className = 'form-group';
  const labelLabel = document.createElement('label');
  labelLabel.htmlFor = 'menu-item-label';
  labelLabel.textContent = 'Button Label';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.id = 'menu-item-label';
  labelInput.className = 'input';
  labelInput.maxLength = MAX_MENU_LABEL_CHARS;
  labelInput.placeholder = 'e.g. Shipping Info, Return Policy, Store Hours';
  labelInput.value = existingItem ? existingItem.label : '';

  const labelCharCount = document.createElement('div');
  labelCharCount.className = 'char-count';
  labelCharCount.id = 'menu-label-char-count';
  labelCharCount.textContent = `${labelInput.value.length} / ${MAX_MENU_LABEL_CHARS} characters`;
  labelInput.addEventListener('input', () => {
    labelCharCount.textContent = `${labelInput.value.length} / ${MAX_MENU_LABEL_CHARS} characters`;
  });

  labelGroup.appendChild(labelLabel);
  labelGroup.appendChild(labelInput);
  labelGroup.appendChild(labelCharCount);
  body.appendChild(labelGroup);

  // Response group
  const respGroup = document.createElement('div');
  respGroup.className = 'form-group';
  const respLabel = document.createElement('label');
  respLabel.htmlFor = 'menu-item-response';
  respLabel.textContent = 'Owner Response';
  const respInput = document.createElement('textarea');
  respInput.id = 'menu-item-response';
  respInput.className = 'input';
  respInput.style.minHeight = '120px';
  respInput.maxLength = MAX_MENU_RESPONSE_CHARS;
  respInput.placeholder = 'e.g. Orders ship within 1-2 business days. Standard delivery takes 3-5 business days across the US.';
  respInput.value = existingItem ? existingItem.response : '';

  const respCharCount = document.createElement('div');
  respCharCount.className = 'char-count';
  respCharCount.id = 'menu-response-char-count';
  respCharCount.textContent = `${respInput.value.length} / ${MAX_MENU_RESPONSE_CHARS} characters`;
  respInput.addEventListener('input', () => {
    respCharCount.textContent = `${respInput.value.length} / ${MAX_MENU_RESPONSE_CHARS} characters`;
  });

  respGroup.appendChild(respLabel);
  respGroup.appendChild(respInput);
  respGroup.appendChild(respCharCount);
  body.appendChild(respGroup);

  // Error alert
  const errEl = document.createElement('div');
  errEl.className = 'alert alert-danger';
  errEl.id = 'menu-modal-error';
  errEl.style.display = 'none';
  errEl.setAttribute('role', 'alert');
  body.appendChild(errEl);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.id = 'cancel-quick-answer-btn';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.id = 'save-quick-answer-btn';
  saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Quick Answer';
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  modal.appendChild(hdr);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  setTimeout(() => labelInput.focus(), 50);

  function close() { backdrop.remove(); }
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escListener); }
  });

  saveBtn.addEventListener('click', async () => {
    errEl.style.display = 'none';
    const label = labelInput.value.trim();
    const response = respInput.value.trim();

    if (!label) {
      errEl.textContent = 'Button Label is required.';
      errEl.style.display = 'block';
      labelInput.focus();
      return;
    }
    if (label.length > MAX_MENU_LABEL_CHARS) {
      errEl.textContent = `Label must not exceed ${MAX_MENU_LABEL_CHARS} characters.`;
      errEl.style.display = 'block';
      return;
    }
    if (!response) {
      errEl.textContent = 'Owner Response is required.';
      errEl.style.display = 'block';
      respInput.focus();
      return;
    }
    if (response.length > MAX_MENU_RESPONSE_CHARS) {
      errEl.textContent = `Response must not exceed ${MAX_MENU_RESPONSE_CHARS} characters.`;
      errEl.style.display = 'block';
      return;
    }

    saveBtn.classList.add('loading');
    saveBtn.disabled = true;
    cancelBtn.disabled = true;

    let res;
    if (isEdit) {
      res = await updateMenuItem(bot.id, existingItem.id, { label, response });
    } else {
      res = await createMenuItem(bot.id, label, response);
    }

    saveBtn.classList.remove('loading');
    saveBtn.disabled = false;
    cancelBtn.disabled = false;

    if (!res.ok) {
      errEl.textContent = res.error;
      errEl.style.display = 'block';
      return;
    }

    close();
    showToast(isEdit ? 'Quick Answer updated.' : 'Quick Answer added.', 'success');
    if (isEdit) {
      onSaved({ label, response });
    } else {
      onSaved(res.data);
    }
  });
}

function openDeleteMenuItemModal(bot, item, onDeleted) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const hdr = document.createElement('div');
  hdr.className = 'modal-header';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.textContent = 'Delete Quick Answer';
  hdr.appendChild(title);

  const body = document.createElement('div');
  body.className = 'modal-body';
  const p = document.createElement('p');
  p.style.fontSize = '0.9375rem';
  p.style.color = 'var(--neutral-700)';
  p.textContent = 'Are you sure you want to delete "';
  const strong = document.createElement('strong');
  strong.textContent = item.label;
  const suffix = document.createTextNode('"? It will no longer be available in the widget.');
  p.appendChild(strong);
  p.appendChild(suffix);
  body.appendChild(p);

  const errEl = document.createElement('div');
  errEl.className = 'alert alert-danger';
  errEl.style.display = 'none';
  errEl.setAttribute('role', 'alert');
  body.appendChild(errEl);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger-solid';
  deleteBtn.id = 'confirm-delete-quick-answer-btn';
  deleteBtn.textContent = 'Delete';
  footer.appendChild(cancelBtn);
  footer.appendChild(deleteBtn);

  modal.appendChild(hdr);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  setTimeout(() => cancelBtn.focus(), 50);

  function close() { backdrop.remove(); }
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escListener); }
  });

  deleteBtn.addEventListener('click', async () => {
    errEl.style.display = 'none';
    deleteBtn.classList.add('loading');
    deleteBtn.disabled = true;
    cancelBtn.disabled = true;

    const res = await deleteMenuItem(bot.id, item.id);
    deleteBtn.classList.remove('loading');

    if (!res.ok) {
      deleteBtn.disabled = false;
      cancelBtn.disabled = false;
      errEl.textContent = res.error;
      errEl.style.display = 'block';
      return;
    }

    close();
    showToast('Quick Answer deleted.', 'default');
    onDeleted();
  });
}

// ==========================================================================
// SECTION 5: Preview Chat
// ==========================================================================
function buildPreviewSection(bot) {
  const section = document.createElement('div');
  section.className = 'section';

  const hdr = document.createElement('div');
  hdr.className = 'section-header';
  const titleDiv = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = 'Preview';
  const sub = document.createElement('div');
  sub.className = 'section-subtitle';
  sub.textContent = 'Test your bot as the owner. This preview uses your authenticated session.';
  titleDiv.appendChild(t);
  titleDiv.appendChild(sub);
  hdr.appendChild(titleDiv);
  section.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'section-body';

  // Privacy notice — always visible
  const notice = document.createElement('div');
  notice.className = 'alert alert-warning';
  notice.style.marginBottom = '16px';
  notice.textContent = 'Do not enter passwords, payment information, personal identifiers, or other sensitive information into this chat.';
  body.appendChild(notice);

  // Chat container
  const chatEl = document.createElement('div');
  chatEl.className = 'chat-container';

  const messagesEl = document.createElement('div');
  messagesEl.className = 'chat-messages';
  messagesEl.id = 'preview-messages';
  messagesEl.setAttribute('aria-live', 'polite');

  // Welcome message
  addChatMessage(messagesEl, 'system', 'Bot preview loaded. Ask a question to test your bot.');

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';

  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.className = 'chat-input';
  chatInput.id = 'preview-chat-input';
  chatInput.placeholder = 'Ask a question…';
  chatInput.maxLength = 2000;
  chatInput.setAttribute('aria-label', 'Preview chat message');

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'chat-send-btn';
  sendBtn.id = 'preview-send-btn';
  sendBtn.setAttribute('aria-label', 'Send message');
  sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

  inputRow.appendChild(chatInput);
  inputRow.appendChild(sendBtn);

  // Usage counter
  const usageEl = document.createElement('div');
  usageEl.className = 'chat-usage';
  usageEl.id = 'preview-usage';
  usageEl.textContent = 'Preview messages today: — / 100';

  chatEl.appendChild(messagesEl);
  chatEl.appendChild(inputRow);
  chatEl.appendChild(usageEl);
  body.appendChild(chatEl);
  section.appendChild(body);

  let previewCount = 0;
  const previewLimit = 100;

  async function sendPreviewMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    chatInput.value = '';
    addChatMessage(messagesEl, 'user', text);

    chatInput.disabled = true;
    sendBtn.disabled = true;
    const typingEl = addTypingIndicator(messagesEl);

    const res = await previewChat(bot.id, text);

    typingEl.remove();
    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();

    if (res.status === 401) {
      addChatMessage(messagesEl, 'system', 'Session expired. Please log in again.');
      return;
    }

    if (!res.ok) {
      addChatMessage(messagesEl, 'system', res.error);
      return;
    }

    addChatMessage(messagesEl, 'bot', res.data.answer); // AI response — textContent
    previewCount++;
    usageEl.textContent = `Preview messages today: ${previewCount} / ${previewLimit}`;
  }

  sendBtn.addEventListener('click', sendPreviewMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendPreviewMessage(); }
  });

  return section;
}

// ==========================================================================
// SECTION 5: Publish & Share
// ==========================================================================
function buildPublishSection(bot, navigate) {
  const section = document.createElement('div');
  section.className = 'section';

  const hdr = document.createElement('div');
  hdr.className = 'section-header';
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = 'Publish & Share';
  hdr.appendChild(t);
  section.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'section-body';

  // State banner + controls
  const bannerEl = document.createElement('div');
  body.appendChild(bannerEl);

  // Share link (shown when public)
  const shareEl = document.createElement('div');
  shareEl.id = 'share-section';
  shareEl.style.display = bot.is_public ? 'block' : 'none';
  body.appendChild(shareEl);

  section.appendChild(body);

  let currentBot = { ...bot };

  function refreshPublishUI() {
    bannerEl.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'publish-banner ' + (currentBot.is_public ? 'public' : 'private');

    const bannerText = document.createElement('div');
    bannerText.className = 'publish-banner-text';
    const bannerTitle = document.createElement('div');
    bannerTitle.className = 'publish-banner-title';
    bannerTitle.textContent = currentBot.is_public ? '🟢 Public' : '🔒 Private';
    const bannerSub = document.createElement('div');
    bannerSub.className = 'publish-banner-sub';
    bannerSub.textContent = currentBot.is_public
      ? 'Your bot is publicly accessible to anyone with the link.'
      : 'Your bot is only available to you for preview.';
    bannerText.appendChild(bannerTitle);
    bannerText.appendChild(bannerSub);

    const actionBtn = document.createElement('button');

    if (currentBot.is_public) {
      actionBtn.className = 'btn btn-secondary btn-sm';
      actionBtn.textContent = 'Make Private';
      actionBtn.addEventListener('click', async () => {
        actionBtn.classList.add('loading');
        actionBtn.disabled = true;
        const res = await unpublishBot(currentBot.id);
        actionBtn.classList.remove('loading');
        actionBtn.disabled = false;
        if (!res.ok) { showToast(res.error, 'error'); return; }
        currentBot.is_public = 0;
        refreshPublishUI();
        refreshShareUI();
        showToast('Bot is now private.', 'default');
      });
    } else {
      actionBtn.className = 'btn btn-primary btn-sm';
      actionBtn.textContent = 'Make Public';
      actionBtn.addEventListener('click', () => openPublishModal(currentBot, () => {
        currentBot.is_public = 1;
        refreshPublishUI();
        refreshShareUI();
        showToast('Bot is now public!', 'success');
      }));
    }

    banner.appendChild(bannerText);
    banner.appendChild(actionBtn);
    bannerEl.appendChild(banner);
  }

  function refreshShareUI() {
    shareEl.innerHTML = '';
    shareEl.style.display = currentBot.is_public ? 'block' : 'none';
    if (!currentBot.is_public) return;

    const shareUrl = `${PROD_DOMAIN}/chat/${currentBot.id}`;
    const embedCode = `<script\n  src="${PROD_DOMAIN}/widget.js"\n  data-bot-id="${currentBot.id}">\n</script>`;

    const div = document.createElement('div');
    div.style.marginTop = '16px';

    // Share link
    const shareLinkLabel = document.createElement('label');
    shareLinkLabel.className = 'form-group';
    shareLinkLabel.style.display = 'flex';
    shareLinkLabel.style.flexDirection = 'column';
    shareLinkLabel.style.gap = '6px';
    const shareLabelText = document.createElement('span');
    shareLabelText.style.fontSize = '0.875rem';
    shareLabelText.style.fontWeight = '500';
    shareLabelText.style.color = 'var(--neutral-700)';
    shareLabelText.textContent = 'Public Chat Link';
    const shareRow = document.createElement('div');
    shareRow.className = 'share-link-row';
    const shareInput = document.createElement('input');
    shareInput.type = 'text';
    shareInput.className = 'share-link-input';
    shareInput.readOnly = true;
    shareInput.value = shareUrl; // safe — .value, not innerHTML
    shareInput.id = 'share-link-input';
    const copyLinkBtn = document.createElement('button');
    copyLinkBtn.className = 'btn btn-secondary btn-sm';
    copyLinkBtn.id = 'copy-link-btn';
    copyLinkBtn.textContent = 'Copy';
    copyLinkBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(shareUrl).then(() => {
        copyLinkBtn.textContent = 'Copied!';
        setTimeout(() => { copyLinkBtn.textContent = 'Copy'; }, 2000);
      });
    });
    shareRow.appendChild(shareInput);
    shareRow.appendChild(copyLinkBtn);
    shareLinkLabel.appendChild(shareLabelText);
    shareLinkLabel.appendChild(shareRow);
    div.appendChild(shareLinkLabel);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'divider';
    div.appendChild(divider);

    // Embed code
    const embedLabel = document.createElement('div');
    embedLabel.style.fontSize = '0.875rem';
    embedLabel.style.fontWeight = '500';
    embedLabel.style.color = 'var(--neutral-700)';
    embedLabel.style.marginBottom = '8px';
    embedLabel.textContent = 'Embed Code';
    div.appendChild(embedLabel);

    const embedHint = document.createElement('p');
    embedHint.className = 'form-hint';
    embedHint.style.marginBottom = '10px';
    embedHint.textContent = 'Paste this before the closing </body> tag on your website.';
    div.appendChild(embedHint);

    const codeBlock = document.createElement('div');
    codeBlock.className = 'code-block';
    const pre = document.createElement('pre');
    pre.textContent = embedCode; // XSS safe — textContent
    const copyCodeBtn = document.createElement('button');
    copyCodeBtn.className = 'code-copy-btn';
    copyCodeBtn.id = 'copy-embed-btn';
    copyCodeBtn.textContent = 'Copy';
    copyCodeBtn.setAttribute('aria-label', 'Copy embed code');
    copyCodeBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(embedCode).then(() => {
        copyCodeBtn.textContent = 'Copied!';
        copyCodeBtn.classList.add('copied');
        setTimeout(() => {
          copyCodeBtn.textContent = 'Copy';
          copyCodeBtn.classList.remove('copied');
        }, 2000);
      });
    });
    codeBlock.appendChild(pre);
    codeBlock.appendChild(copyCodeBtn);
    div.appendChild(codeBlock);

    shareEl.appendChild(div);
  }

  refreshPublishUI();
  refreshShareUI();

  return section;
}

// ==========================================================================
// Publish Confirmation Modal
// ==========================================================================
function openPublishModal(bot, onConfirmed) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'publish-modal-title');

  const modal = document.createElement('div');
  modal.className = 'modal';

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'modal-header';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.id = 'publish-modal-title';
  title.textContent = 'Make Bot Public';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Cancel');
  closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  hdr.appendChild(title);
  hdr.appendChild(closeBtn);

  // Body
  const body = document.createElement('div');
  body.className = 'modal-body';

  const intro = document.createElement('p');
  intro.style.fontSize = '0.9375rem';
  intro.style.color = 'var(--neutral-600)';
  intro.style.marginBottom = '4px';
  intro.textContent = 'Before publishing, please confirm the following:';
  body.appendChild(intro);

  const checkGroup = document.createElement('div');
  checkGroup.className = 'check-group';
  checkGroup.setAttribute('role', 'group');

  const confirmations = [
    { id: 'pub-check-1', label: 'I have permission to publish this knowledge base and its contents.' },
    { id: 'pub-check-2', label: 'This knowledge base does not contain sensitive, private, or confidential information.' },
    { id: 'pub-check-3', label: 'I understand that visitors may ask questions that cause information from the knowledge base to appear in AI responses.' },
  ];

  const checkboxes = confirmations.map(({ id, label }) => {
    const item = document.createElement('label');
    item.className = 'check-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.addEventListener('change', updateSubmitState);
    const labelText = document.createElement('span');
    labelText.className = 'check-item-label';
    labelText.textContent = label; // safe
    item.appendChild(cb);
    item.appendChild(labelText);
    checkGroup.appendChild(item);
    return cb;
  });

  body.appendChild(checkGroup);

  const errEl = document.createElement('div');
  errEl.className = 'alert alert-danger';
  errEl.style.display = 'none';
  errEl.setAttribute('role', 'alert');
  body.appendChild(errEl);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  const publishBtn = document.createElement('button');
  publishBtn.className = 'btn btn-primary';
  publishBtn.id = 'confirm-publish-btn';
  publishBtn.textContent = 'Publish Bot';
  publishBtn.disabled = true;
  footer.appendChild(cancelBtn);
  footer.appendChild(publishBtn);

  modal.appendChild(hdr);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  setTimeout(() => checkboxes[0]?.previousElementSibling?.focus() || checkboxes[0]?.focus(), 50);

  function updateSubmitState() {
    publishBtn.disabled = !checkboxes.every(cb => cb.checked);
  }

  function close() { backdrop.remove(); }
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escListener); }
  });

  publishBtn.addEventListener('click', async () => {
    errEl.style.display = 'none';
    if (!checkboxes.every(cb => cb.checked)) {
      errEl.textContent = 'Please confirm all items before publishing.';
      errEl.style.display = 'block';
      return;
    }

    publishBtn.classList.add('loading');
    publishBtn.disabled = true;
    cancelBtn.disabled = true;

    const res = await publishBot(bot.id);
    publishBtn.classList.remove('loading');

    if (!res.ok) {
      cancelBtn.disabled = false;
      publishBtn.disabled = false;
      errEl.textContent = res.error;
      errEl.style.display = 'block';
      return;
    }

    close();
    onConfirmed();
  });
}

// ==========================================================================
// Delete source confirmation modal
// ==========================================================================
function openDeleteSourceModal(src, onConfirmed) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'alertdialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'del-src-title');

  const modal = document.createElement('div');
  modal.className = 'modal';

  const hdr = document.createElement('div');
  hdr.className = 'modal-header';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.id = 'del-src-title';
  title.textContent = 'Delete Knowledge Source';
  hdr.appendChild(title);

  const body = document.createElement('div');
  body.className = 'modal-body';
  const p = document.createElement('p');
  p.style.fontSize = '0.9375rem';
  p.style.color = 'var(--neutral-700)';
  p.textContent = 'Delete "';
  const strong = document.createElement('strong');
  strong.textContent = src.filename; // XSS safe
  const p2 = document.createTextNode('"? This will permanently remove the file and its associated knowledge.');
  p.appendChild(strong);
  p.appendChild(p2);
  body.appendChild(p);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger-solid';
  deleteBtn.textContent = 'Delete';
  footer.appendChild(cancelBtn);
  footer.appendChild(deleteBtn);

  modal.appendChild(hdr);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  setTimeout(() => deleteBtn.focus(), 50);

  function close() { backdrop.remove(); }
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escListener); }
  });

  deleteBtn.addEventListener('click', async () => {
    deleteBtn.classList.add('loading');
    deleteBtn.disabled = true;
    cancelBtn.disabled = true;
    await onConfirmed();
    close();
  });
}

// ==========================================================================
// Delete bot confirmation modal
// ==========================================================================
function openDeleteBotModal(bot, navigate) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'alertdialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'del-bot-title');

  const modal = document.createElement('div');
  modal.className = 'modal';

  const hdr = document.createElement('div');
  hdr.className = 'modal-header';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.id = 'del-bot-title';
  title.textContent = 'Delete Bot';
  hdr.appendChild(title);

  const body = document.createElement('div');
  body.className = 'modal-body';
  const p = document.createElement('p');
  p.style.fontSize = '0.9375rem';
  p.style.color = 'var(--neutral-700)';
  p.textContent = 'Delete "';
  const strong = document.createElement('strong');
  strong.textContent = bot.name; // XSS safe
  const suffix = document.createTextNode('"? This will permanently remove the bot and all of its knowledge.');
  p.appendChild(strong);
  p.appendChild(suffix);
  body.appendChild(p);

  const errEl = document.createElement('div');
  errEl.className = 'alert alert-danger';
  errEl.style.display = 'none';
  errEl.setAttribute('role', 'alert');
  body.appendChild(errEl);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger-solid';
  deleteBtn.id = 'confirm-delete-bot-btn';
  deleteBtn.textContent = 'Delete Bot';
  footer.appendChild(cancelBtn);
  footer.appendChild(deleteBtn);

  modal.appendChild(hdr);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  setTimeout(() => cancelBtn.focus(), 50); // focus Cancel by default for safety

  function close() { backdrop.remove(); }
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escListener); }
  });

  deleteBtn.addEventListener('click', async () => {
    errEl.style.display = 'none';
    deleteBtn.classList.add('loading');
    deleteBtn.disabled = true;
    cancelBtn.disabled = true;

    const res = await deleteBot(bot.id);
    deleteBtn.classList.remove('loading');

    if (!res.ok) {
      deleteBtn.disabled = false;
      cancelBtn.disabled = false;
      errEl.textContent = res.error;
      errEl.style.display = 'block';
      return;
    }

    close();
    showToast('Bot deleted.', 'default');
    navigate('dashboard');
  });
}

// ==========================================================================
// Shared helpers
// ==========================================================================
function buildSaveRow(statusId, onSave) {
  const row = document.createElement('div');
  row.className = 'save-row';

  const status = document.createElement('span');
  status.className = 'save-status hidden';
  status.id = statusId;
  status.setAttribute('aria-live', 'polite');

  const btn = document.createElement('button');
  btn.className = 'btn btn-secondary btn-sm';
  btn.textContent = 'Save changes';

  btn.addEventListener('click', async () => {
    btn.classList.add('loading');
    btn.disabled = true;
    status.textContent = '';
    status.className = 'save-status hidden';

    const res = await onSave();
    btn.classList.remove('loading');
    btn.disabled = false;

    if (!res) return; // cancelled
    if (res.ok) {
      status.textContent = '✓ Saved';
      status.className = 'save-status saved';
    } else {
      status.textContent = res.error;
      status.className = 'save-status error';
    }

    setTimeout(() => {
      status.className = 'save-status hidden';
    }, 3000);
  });

  row.appendChild(status);
  row.appendChild(btn);
  return row;
}

function addChatMessage(container, role, text) {
  const el = document.createElement('div');
  el.className = 'chat-message ' + role;
  el.textContent = text; // XSS safe — textContent for ALL messages including AI
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function addTypingIndicator(container) {
  const el = document.createElement('div');
  el.className = 'chat-message bot';
  el.innerHTML = `<div class="typing-indicator" aria-label="Bot is typing"><span></span><span></span><span></span></div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
