/**
 * PreBase SPA Router & App Shell
 * Hash-based routing with auth guard.
 * Routes: #login, #register, #dashboard, #bot/<id>
 */

import { getMe, logout } from './api.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderBot } from './views/bot.js';

// --------------------------------------------------------------------------
// App state (plain object — no framework needed for MVP)
// --------------------------------------------------------------------------
export const appState = {
  user: null, // { id, email } when authenticated
};

// --------------------------------------------------------------------------
// Toast notifications
// --------------------------------------------------------------------------
export function showToast(message, type = 'default') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast' + (type !== 'default' ? ` ${type}` : '');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// --------------------------------------------------------------------------
// Auth helpers
// --------------------------------------------------------------------------
export function setUser(user) {
  appState.user = user;
  const emailEl = document.getElementById('topbar-email');
  if (emailEl && user) emailEl.textContent = user.email;
}

function showAppShell() {
  document.getElementById('auth-root').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('app').style.flexDirection = 'column';
  document.getElementById('app').style.minHeight = '100vh';
}

function showAuthRoot() {
  document.getElementById('auth-root').style.display = 'block';
  document.getElementById('app').style.display = 'none';
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------
function getRoute() {
  const hash = window.location.hash.slice(1) || 'dashboard';
  return hash;
}

async function navigate(route) {
  if (route && route !== getRoute()) {
    window.location.hash = route;
    return; // hashchange will fire
  }
  await renderRoute(route || getRoute());
}

async function renderRoute(hash) {
  const main = document.getElementById('main');

  if (!hash || hash === 'dashboard') {
    showAppShell();
    await renderDashboard(main, navigate);
    return;
  }

  if (hash === 'login' || hash === 'register') {
    showAuthRoot();
    renderLogin(
      document.getElementById('auth-root'),
      hash === 'register' ? 'register' : 'login',
      (user) => {
        setUser(user);
        window.location.hash = 'dashboard';
      }
    );
    return;
  }

  if (hash.startsWith('bot/')) {
    const botId = hash.slice(4);
    if (!botId) {
      window.location.hash = 'dashboard';
      return;
    }
    showAppShell();
    await renderBot(main, botId, navigate);
    return;
  }

  // Fallback
  window.location.hash = 'dashboard';
}

// --------------------------------------------------------------------------
// Initial auth check
// --------------------------------------------------------------------------
async function init() {
  // Show loading
  document.getElementById('auth-root').innerHTML = `
    <div class="app-loading">
      <div class="spinner" aria-hidden="true"></div>
      <span>Loading…</span>
    </div>
  `;
  document.getElementById('auth-root').style.display = 'block';
  document.getElementById('app').style.display = 'none';

  const res = await getMe();

  if (res.ok && res.data?.user) {
    setUser(res.data.user);
    showAppShell();
    await renderRoute(getRoute());
  } else {
    // Not authenticated — go to login (preserve #register if already there)
    const hash = getRoute();
    showAuthRoot();
    renderLogin(
      document.getElementById('auth-root'),
      hash === 'register' ? 'register' : 'login',
      (user) => {
        setUser(user);
        window.location.hash = 'dashboard';
      }
    );
  }
}

// --------------------------------------------------------------------------
// Hash change listener
// --------------------------------------------------------------------------
window.addEventListener('hashchange', async () => {
  const hash = getRoute();

  // Auth guard: if not logged in, redirect to login
  if (!appState.user) {
    if (hash !== 'login' && hash !== 'register') {
      window.location.hash = 'login';
      return;
    }
  }

  await renderRoute(hash);
});

// --------------------------------------------------------------------------
// Logout button
// --------------------------------------------------------------------------
document.getElementById('logout-btn').addEventListener('click', async () => {
  const btn = document.getElementById('logout-btn');
  btn.classList.add('loading');
  btn.disabled = true;

  await logout();
  appState.user = null;
  window.location.hash = 'login';
  // Force re-render (hashchange may not fire if already on #login)
  showAuthRoot();
  renderLogin(
    document.getElementById('auth-root'),
    'login',
    (user) => {
      setUser(user);
      window.location.hash = 'dashboard';
    }
  );

  btn.classList.remove('loading');
  btn.disabled = false;
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
init();
