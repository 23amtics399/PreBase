/**
 * Dashboard view — Bot list with empty state.
 * All user-controlled values rendered via textContent (XSS safe).
 */

import { getBots, createBot, deleteBot } from '../api.js';
import { showToast } from '../app.js';

export async function renderDashboard(container, navigate) {
  // Loading skeleton
  container.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'page-header';

  const h1 = document.createElement('h1');
  h1.textContent = 'My Bots';

  const createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary';
  createBtn.id = 'create-bot-btn';
  createBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  `;
  const createBtnText = document.createTextNode(' Create Bot');
  createBtn.appendChild(createBtnText);

  header.appendChild(h1);
  header.appendChild(createBtn);
  container.appendChild(header);

  const listContainer = document.createElement('div');
  listContainer.id = 'bots-list';
  listContainer.innerHTML = `<div class="app-loading" style="min-height:300px;"><div class="spinner" aria-hidden="true"></div><span>Loading bots…</span></div>`;
  container.appendChild(listContainer);

  // Fetch bots
  const res = await getBots();

  if (!res.ok) {
    if (res.status === 401) {
      window.location.hash = 'login';
      return;
    }
    listContainer.innerHTML = '';
    const errAlert = document.createElement('div');
    errAlert.className = 'alert alert-danger';
    errAlert.textContent = res.error;
    listContainer.appendChild(errAlert);
    return;
  }

  const bots = res.data?.bots || [];
  renderBotList(listContainer, bots, navigate);

  // Create bot button
  createBtn.addEventListener('click', () => openCreateModal(navigate));
}

// --------------------------------------------------------------------------
// Render bot list or empty state
// --------------------------------------------------------------------------
function renderBotList(container, bots, navigate) {
  container.innerHTML = '';

  if (bots.length === 0) {
    container.appendChild(buildEmptyState(navigate));
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'bots-grid';

  bots.forEach(bot => {
    const card = buildBotCard(bot, navigate);
    grid.appendChild(card);
  });

  container.appendChild(grid);
}

// --------------------------------------------------------------------------
// Bot card (all values via textContent — XSS safe)
// --------------------------------------------------------------------------
function buildBotCard(bot, navigate) {
  const card = document.createElement('div');
  card.className = 'bot-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', 'Manage ' + bot.name);

  // Top row
  const top = document.createElement('div');
  top.className = 'bot-card-top';

  const nameEl = document.createElement('div');
  nameEl.className = 'bot-card-name';
  nameEl.textContent = bot.name; // XSS safe

  const badge = document.createElement('div');
  badge.className = 'badge ' + (bot.is_public ? 'badge-public' : 'badge-private');
  const dot = document.createElement('span');
  dot.className = 'badge-dot';
  const badgeText = document.createTextNode(bot.is_public ? 'Public' : 'Private');
  badge.appendChild(dot);
  badge.appendChild(badgeText);

  top.appendChild(nameEl);
  top.appendChild(badge);

  // Description
  if (bot.description) {
    const desc = document.createElement('div');
    desc.className = 'bot-card-desc';
    desc.textContent = bot.description; // XSS safe
    card.appendChild(top);
    card.appendChild(desc);
  } else {
    card.appendChild(top);
  }

  // Footer
  const footer = document.createElement('div');
  footer.className = 'bot-card-footer';

  const metaEl = document.createElement('div');
  metaEl.className = 'bot-card-meta';
  metaEl.textContent = 'Updated ' + formatDate(bot.updated_at);

  const manageBtn = document.createElement('button');
  manageBtn.className = 'btn btn-secondary btn-sm';
  manageBtn.textContent = 'Manage';

  footer.appendChild(metaEl);
  footer.appendChild(manageBtn);
  card.appendChild(footer);

  // Click navigation
  const goToBot = () => navigate('bot/' + bot.id);
  card.addEventListener('click', goToBot);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      goToBot();
    }
  });
  // Stop manage button from double-firing
  manageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('bot/' + bot.id);
  });

  return card;
}

// --------------------------------------------------------------------------
// Empty state
// --------------------------------------------------------------------------
function buildEmptyState(navigate) {
  const el = document.createElement('div');
  el.className = 'empty-state';

  el.innerHTML = `
    <div class="empty-state-icon" aria-hidden="true">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"></path>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
    </div>
  `;

  const h2 = document.createElement('h2');
  h2.textContent = 'Create your first AI assistant';

  const p = document.createElement('p');
  p.textContent = 'Build a chatbot that answers questions about your content. Upload documents, configure behaviour, and embed it on any website.';

  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = '+ Create Bot';
  btn.addEventListener('click', () => openCreateModal(navigate));

  el.appendChild(h2);
  el.appendChild(p);
  el.appendChild(btn);
  return el;
}

// --------------------------------------------------------------------------
// Create bot modal
// --------------------------------------------------------------------------
function openCreateModal(navigate) {
  // Build modal using DOM APIs
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'create-modal-title');

  const modal = document.createElement('div');
  modal.className = 'modal';

  // Header
  const modalHeader = document.createElement('div');
  modalHeader.className = 'modal-header';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.id = 'create-modal-title';
  title.textContent = 'Create a New Bot';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Close dialog');
  closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  modalHeader.appendChild(title);
  modalHeader.appendChild(closeBtn);

  // Body
  const body = document.createElement('div');
  body.className = 'modal-body';

  const nameGroup = document.createElement('div');
  nameGroup.className = 'form-group';
  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'new-bot-name';
  nameLabel.textContent = 'Bot Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'new-bot-name';
  nameInput.className = 'input';
  nameInput.placeholder = 'e.g. Support Assistant';
  nameInput.maxLength = 100;
  nameInput.required = true;
  nameGroup.appendChild(nameLabel);
  nameGroup.appendChild(nameInput);

  const descGroup = document.createElement('div');
  descGroup.className = 'form-group';
  const descLabel = document.createElement('label');
  descLabel.htmlFor = 'new-bot-desc';
  descLabel.textContent = 'Short Description (optional)';
  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.id = 'new-bot-desc';
  descInput.className = 'input';
  descInput.placeholder = 'e.g. Answers questions about our product';
  descInput.maxLength = 500;
  descGroup.appendChild(descLabel);
  descGroup.appendChild(descInput);

  const errEl = document.createElement('div');
  errEl.className = 'alert alert-danger';
  errEl.style.display = 'none';
  errEl.setAttribute('role', 'alert');

  body.appendChild(nameGroup);
  body.appendChild(descGroup);
  body.appendChild(errEl);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.id = 'create-bot-submit';
  submitBtn.textContent = 'Create Bot';
  footer.appendChild(cancelBtn);
  footer.appendChild(submitBtn);

  modal.appendChild(modalHeader);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Focus first input
  setTimeout(() => nameInput.focus(), 50);

  // Close handlers
  function close() { backdrop.remove(); }
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function escListener(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escListener); }
  });

  // Submit
  async function submit() {
    errEl.style.display = 'none';
    const name = nameInput.value.trim();
    if (!name) {
      errEl.textContent = 'Bot name is required.';
      errEl.style.display = 'block';
      nameInput.focus();
      return;
    }

    submitBtn.classList.add('loading');
    submitBtn.disabled = true;
    cancelBtn.disabled = true;

    const res = await createBot(name, descInput.value.trim(), '');

    submitBtn.classList.remove('loading');
    submitBtn.disabled = false;
    cancelBtn.disabled = false;

    if (!res.ok) {
      errEl.textContent = res.error;
      errEl.style.display = 'block';
      nameInput.focus();
      return;
    }

    close();
    showToast('Bot created!', 'success');
    navigate('bot/' + res.data.id);
  }

  submitBtn.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  descInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function formatDate(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
