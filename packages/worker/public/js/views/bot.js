/**
 * Bot editor view — all sections: info, instructions, knowledge, preview, publish.
 * XSS safety: all user/AI content rendered via textContent or safe DOM APIs.
 */

import {
  getBot, updateBot, deleteBot,
  getKnowledge, uploadKnowledge, deleteKnowledge,
  previewChat, publishBot, unpublishBot,
} from '../api.js';
import { showToast } from '../app.js';

// Production domain for share/embed links
const PROD_DOMAIN = 'https://prebase.sji.one';

// KB limits (mirrors wrangler.toml defaults — displayed for UX only; server is authoritative)
const MAX_SOURCES = 10;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // 3 MB

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

  // Fetch bot and knowledge in parallel
  const [botRes, kbRes] = await Promise.all([getBot(botId), getKnowledge(botId)]);

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

  // Info notice
  const notice = document.createElement('div');
  notice.className = 'alert alert-info';
  notice.style.marginBottom = '16px';
  notice.textContent = 'Instructions influence how the AI responds, but do not guarantee perfect compliance with every rule. Use clear, specific language for best results.';

  const promptGroup = document.createElement('div');
  promptGroup.className = 'form-group';
  const promptLabel = document.createElement('label');
  promptLabel.htmlFor = 'bot-prompt';
  promptLabel.textContent = 'System Instructions';
  const promptInput = document.createElement('textarea');
  promptInput.id = 'bot-prompt';
  promptInput.className = 'input';
  promptInput.style.minHeight = '140px';
  promptInput.maxLength = 5000;
  promptInput.placeholder =
    'Example: "You are a friendly support assistant for Acme Inc. Help users with product questions. Politely decline questions unrelated to Acme products. Always suggest contacting support@acme.com for billing issues."';
  promptInput.value = bot.system_prompt || ''; // safe — .value

  const charCount = document.createElement('div');
  charCount.className = 'char-count';
  charCount.textContent = `${(bot.system_prompt || '').length} / 5000`;
  promptInput.addEventListener('input', () => {
    charCount.textContent = `${promptInput.value.length} / 5000`;
  });

  promptGroup.appendChild(promptLabel);
  promptGroup.appendChild(promptInput);
  promptGroup.appendChild(charCount);

  const saveRow = buildSaveRow('instructions-save-status', async () => {
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
  sub.textContent = 'Upload text files your bot uses to answer questions.';
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

  // Usage summary
  const usageSummaryEl = document.createElement('div');
  body.appendChild(usageSummaryEl);

  // Source list
  const sourceListEl = document.createElement('div');
  sourceListEl.className = 'source-list';
  sourceListEl.id = 'source-list';
  body.appendChild(sourceListEl);

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

  // Upload zone
  const uploadSection = document.createElement('div');
  uploadSection.style.marginTop = '16px';

  const uploadZone = document.createElement('div');
  uploadZone.className = 'upload-zone';
  uploadZone.id = 'upload-zone';
  uploadZone.setAttribute('role', 'button');
  uploadZone.setAttribute('tabindex', '0');
  uploadZone.setAttribute('aria-label', 'Upload knowledge file');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.txt,.md';
  fileInput.id = 'knowledge-file-input';
  fileInput.setAttribute('aria-label', 'Choose a .txt or .md file');

  uploadZone.innerHTML = `
    <div class="upload-zone-icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="16 16 12 12 8 16"></polyline>
        <line x1="12" y1="12" x2="12" y2="21"></line>
        <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"></path>
      </svg>
    </div>
    <div class="upload-zone-text">Click to upload or drag and drop</div>
    <div class="upload-zone-hint">Supported: .txt, .md — Max 3 MB per file</div>
  `;
  uploadZone.appendChild(fileInput);
  uploadSection.appendChild(uploadZone);

  // Upload status message
  const uploadStatus = document.createElement('div');
  uploadStatus.style.marginTop = '10px';
  uploadStatus.style.fontSize = '0.875rem';
  uploadStatus.id = 'upload-status';
  uploadSection.appendChild(uploadStatus);

  body.appendChild(uploadSection);
  section.appendChild(body);

  // --- State ---
  let sources = [...initialSources];

  function totalBytes() { return sources.reduce((s, src) => s + src.byte_size, 0); }

  function refreshUsage() {
    usageSummaryEl.innerHTML = '';
    const used = totalBytes();
    const pct = Math.min(100, Math.round((used / MAX_TOTAL_BYTES) * 100));
    const dangerous = pct >= 90;
    const warning = pct >= 70;

    const labelRow = document.createElement('div');
    labelRow.className = 'usage-label';
    const leftLabel = document.createElement('span');
    leftLabel.textContent = `Knowledge (${sources.length} / ${MAX_SOURCES} sources)`;
    const rightLabel = document.createElement('span');
    rightLabel.textContent = `${formatBytes(used)} / ${formatBytes(MAX_TOTAL_BYTES)}`;
    labelRow.appendChild(leftLabel);
    labelRow.appendChild(rightLabel);

    const bar = document.createElement('div');
    bar.className = 'usage-bar';
    const fill = document.createElement('div');
    fill.className = 'usage-bar-fill' + (dangerous ? ' danger' : warning ? ' warning' : '');
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    usageSummaryEl.appendChild(labelRow);
    usageSummaryEl.appendChild(bar);
    usageSummaryEl.style.marginBottom = '16px';
  }

  function refreshSourceList() {
    sourceListEl.innerHTML = '';
    if (sources.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'form-hint';
      empty.style.textAlign = 'center';
      empty.style.padding = '12px 0';
      empty.textContent = 'No knowledge sources yet. Add knowledge so your bot can answer questions about your content.';
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

    const ext = (src.filename || '').toLowerCase().endsWith('.md') ? 'MD' : 'TXT';
    const icon = document.createElement('div');
    icon.className = 'source-icon';
    icon.textContent = ext; // safe

    const info = document.createElement('div');
    info.className = 'source-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'source-name';
    nameEl.textContent = src.filename; // XSS safe — filename is user-uploaded
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

    metaEl.textContent = `${formatBytes(src.byte_size)} · ${src.chunk_count} chunk${src.chunk_count !== 1 ? 's' : ''}${enrichStatusText}`;

    info.appendChild(nameEl);
    info.appendChild(metaEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm btn-icon';
    delBtn.setAttribute('aria-label', 'Delete ' + src.filename); // safe via setAttribute
    delBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>`;
    delBtn.style.color = 'var(--danger-500)';

    delBtn.addEventListener('click', () => openDeleteSourceModal(src, async () => {
      const res = await deleteKnowledge(bot.id, src.id);
      if (!res.ok) { showToast(res.error, 'error'); return; }
      sources = sources.filter(s => s.id !== src.id);
      refreshUsage();
      refreshSourceList();
      showToast('Source deleted.', 'success');
    }));

    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(delBtn);
    return item;
  }

  // Initial render
  refreshUsage();
  refreshSourceList();

  // --- Upload handling ---
  async function handleUpload(file) {
    if (!file) return;

    // Client-side validations (server is authoritative)
    const name = file.name.toLowerCase();
    if (!name.endsWith('.txt') && !name.endsWith('.md')) {
      showUploadStatus("This file type isn't supported yet. Please upload a .txt or .md file.", 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showUploadStatus('That file is too large. Maximum upload size is 3 MB.', 'error');
      return;
    }
    if (sources.length >= MAX_SOURCES) {
      showUploadStatus('Maximum number of knowledge sources reached (10).', 'error');
      return;
    }

    showUploadStatus('Uploading…', 'loading');
    uploadZone.style.pointerEvents = 'none';
    fileInput.disabled = true;

    const isEnrichmentEnabled = document.getElementById('enrichment-checkbox').checked;
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
    showUploadStatus(`"${file.name}" uploaded successfully (${res.data.chunk_count} chunks).`, 'success');

    // If enrichment was requested, kick off status polling immediately
    // so the user sees the status update without a manual page refresh.
    section._startPolling?.();
  }

  function showUploadStatus(msg, type) {
    uploadStatus.textContent = msg; // XSS safe
    uploadStatus.style.color = type === 'error' ? 'var(--danger-600)'
      : type === 'success' ? 'var(--success-600)'
      : 'var(--neutral-500)';
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) handleUpload(fileInput.files[0]);
  });

  // Drag and drop
  uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleUpload(file);
  });

  // Keyboard access for upload zone
  uploadZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  // Expose a refresh hook for enrichment-status polling.
  // renderBot() calls section._refreshSources(newSources) while any source is
  // queued/processing. Updates internal state and re-renders only the source
  // list and usage bar — not the whole page.
  section._refreshSources = function(newSources) {
    sources = newSources;
    refreshUsage();
    refreshSourceList();
  };

  return section;
}

// ==========================================================================
// SECTION 4: Preview Chat
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
