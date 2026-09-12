/**
 * Login & Register view
 * Renders into the auth-root element (full-page, no topbar).
 * Calls onSuccess(user) when authentication succeeds.
 */

import { login, register, getMe } from '../api.js?v=6';

export function renderLogin(container, initialTab = 'login', onSuccess) {
  // Build auth page structure using safe DOM APIs
  container.innerHTML = ''; // Clear previous content

  const page = document.createElement('div');
  page.className = 'auth-page';

  const card = document.createElement('div');
  card.className = 'auth-card';

  // Logo
  const logo = document.createElement('div');
  logo.className = 'auth-logo';
  const logoIcon = document.createElement('div');
  logoIcon.className = 'auth-logo-icon';
  logoIcon.textContent = 'PB';
  const logoName = document.createElement('span');
  logoName.className = 'auth-logo-name';
  logoName.textContent = 'PreBase';
  logo.appendChild(logoIcon);
  logo.appendChild(logoName);

  // Tabs
  const tabs = document.createElement('div');
  tabs.className = 'auth-tabs';
  tabs.setAttribute('role', 'tablist');

  const loginTab = document.createElement('button');
  loginTab.className = 'auth-tab' + (initialTab === 'login' ? ' active' : '');
  loginTab.textContent = 'Sign In';
  loginTab.setAttribute('role', 'tab');
  loginTab.setAttribute('aria-selected', initialTab === 'login' ? 'true' : 'false');
  loginTab.id = 'tab-login';
  loginTab.setAttribute('aria-controls', 'panel-login');

  const registerTab = document.createElement('button');
  registerTab.className = 'auth-tab' + (initialTab === 'register' ? ' active' : '');
  registerTab.textContent = 'Create Account';
  registerTab.setAttribute('role', 'tab');
  registerTab.setAttribute('aria-selected', initialTab === 'register' ? 'true' : 'false');
  registerTab.id = 'tab-register';
  registerTab.setAttribute('aria-controls', 'panel-register');

  tabs.appendChild(loginTab);
  tabs.appendChild(registerTab);

  // Error banner
  const errorBanner = document.createElement('div');
  errorBanner.className = 'auth-error';
  errorBanner.setAttribute('role', 'alert');
  errorBanner.id = 'auth-error';

  // Login form
  const loginPanel = document.createElement('div');
  loginPanel.id = 'panel-login';
  loginPanel.setAttribute('role', 'tabpanel');
  loginPanel.style.display = initialTab === 'login' ? 'block' : 'none';
  loginPanel.innerHTML = ''; // safe — we build via DOM

  loginPanel.appendChild(buildForm('login'));

  // Register form
  const registerPanel = document.createElement('div');
  registerPanel.id = 'panel-register';
  registerPanel.setAttribute('role', 'tabpanel');
  registerPanel.style.display = initialTab === 'register' ? 'block' : 'none';
  registerPanel.appendChild(buildForm('register'));

  // Assemble
  card.appendChild(logo);
  card.appendChild(tabs);
  card.appendChild(errorBanner);
  card.appendChild(loginPanel);
  card.appendChild(registerPanel);
  page.appendChild(card);
  container.appendChild(page);

  // ---------- Tab switching ----------
  function switchTab(tab) {
    const isLogin = tab === 'login';
    loginTab.className = 'auth-tab' + (isLogin ? ' active' : '');
    loginTab.setAttribute('aria-selected', isLogin ? 'true' : 'false');
    registerTab.className = 'auth-tab' + (!isLogin ? ' active' : '');
    registerTab.setAttribute('aria-selected', !isLogin ? 'true' : 'false');
    loginPanel.style.display = isLogin ? 'block' : 'none';
    registerPanel.style.display = !isLogin ? 'block' : 'none';
    errorBanner.className = 'auth-error'; // hide error on switch
    window.location.hash = tab;
  }

  loginTab.addEventListener('click', () => switchTab('login'));
  registerTab.addEventListener('click', () => switchTab('register'));

  // ---------- Form submission ----------
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.className = 'auth-error show';
  }
  function hideError() {
    errorBanner.className = 'auth-error';
  }

  async function handleLogin(e) {
    e.preventDefault();
    hideError();

    const emailEl = document.getElementById('login-email');
    const passEl = document.getElementById('login-password');
    const submitEl = document.getElementById('login-submit');

    const email = emailEl.value.trim();
    const password = passEl.value;

    if (!email || !password) {
      showError('Please enter your email and password.');
      emailEl.focus();
      return;
    }

    submitEl.classList.add('loading');
    submitEl.disabled = true;

    const res = await login(email, password);

    submitEl.classList.remove('loading');
    submitEl.disabled = false;

    if (!res.ok) {
      showError(res.error);
      passEl.value = '';
      emailEl.focus();
      return;
    }

    // Fetch user info
    const me = await getMe();
    if (me.ok && me.data?.user) {
      onSuccess(me.data.user);
    } else {
      onSuccess({ email });
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    hideError();

    const emailEl = document.getElementById('reg-email');
    const passEl = document.getElementById('reg-password');
    const pass2El = document.getElementById('reg-password2');
    const submitEl = document.getElementById('reg-submit');

    const email = emailEl.value.trim();
    const password = passEl.value;
    const password2 = pass2El.value;

    if (!email) {
      showError('Please enter your email address.');
      emailEl.focus();
      return;
    }
    if (password.length < 8) {
      showError('Password must be at least 8 characters.');
      passEl.focus();
      return;
    }
    if (password !== password2) {
      showError('Passwords do not match.');
      pass2El.focus();
      return;
    }

    submitEl.classList.add('loading');
    submitEl.disabled = true;

    const res = await register(email, password);

    if (!res.ok) {
      submitEl.classList.remove('loading');
      submitEl.disabled = false;
      showError(res.error);
      emailEl.focus();
      return;
    }

    // Auto-login after registration
    const loginRes = await login(email, password);
    submitEl.classList.remove('loading');
    submitEl.disabled = false;

    if (!loginRes.ok) {
      // Registration worked, but login failed — ask them to sign in
      switchTab('login');
      showError('Account created! Please sign in.');
      return;
    }

    const me = await getMe();
    if (me.ok && me.data?.user) {
      onSuccess(me.data.user);
    } else {
      onSuccess({ email });
    }
  }

  // Attach form submit listeners
  const loginForm = document.getElementById('form-login');
  const registerForm = document.getElementById('form-register');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  if (registerForm) registerForm.addEventListener('submit', handleRegister);
}

// --------------------------------------------------------------------------
// Build form elements using safe DOM APIs
// --------------------------------------------------------------------------
function buildForm(type) {
  const form = document.createElement('form');
  form.id = `form-${type}`;
  form.noValidate = true;

  if (type === 'login') {
    form.appendChild(buildField('login-email', 'email', 'Email', 'your@email.com', 'email', true));
    form.appendChild(buildField('login-password', 'password', 'Password', '••••••••', 'current-password', true));

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'btn btn-primary auth-submit';
    btn.id = 'login-submit';
    btn.textContent = 'Sign In';
    form.appendChild(btn);

  } else {
    form.appendChild(buildField('reg-email', 'email', 'Email', 'your@email.com', 'email', true));
    form.appendChild(buildField('reg-password', 'password', 'Password (min. 8 characters)', '••••••••', 'new-password', true));
    form.appendChild(buildField('reg-password2', 'password', 'Confirm Password', '••••••••', 'new-password', true));

    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.style.marginBottom = '16px';
    hint.textContent = 'By creating an account you agree to use PreBase responsibly and only upload content you are authorised to share.';
    form.appendChild(hint);

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'btn btn-primary auth-submit';
    btn.id = 'reg-submit';
    btn.textContent = 'Create Account';
    form.appendChild(btn);
  }

  return form;
}

function buildField(id, type, labelText, placeholder, autocomplete, required) {
  const group = document.createElement('div');
  group.className = 'form-group';

  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;

  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.className = 'input';
  input.placeholder = placeholder;
  input.autocomplete = autocomplete;
  if (required) input.required = true;

  group.appendChild(label);
  group.appendChild(input);
  return group;
}
