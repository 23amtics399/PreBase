/**
 * PreBase API Client
 * Centralises all fetch calls, credentials, error normalisation, and session handling.
 * Views must import from this module — never write raw fetch() in views.
 */

const BASE = '';

/**
 * Normalise API error responses to user-friendly strings.
 * Never surfaces raw SQL, stack traces, or internal identifiers.
 */
function normaliseError(status, body) {
  if (status === 401) return 'Your session has expired. Please log in again.';
  if (status === 429) {
    const msg = body?.message || '';
    if (msg.includes('preview')) return 'Daily preview limit reached. Please try again tomorrow.';
    if (msg.includes('bot')) return "This bot has reached its daily message limit. Please try again tomorrow.";
    return 'Too many requests. Please try again later.';
  }
  if (status === 413) return body?.message?.includes('total') 
    ? 'Upload would exceed your total knowledge limit (5 MB).'
    : 'That file is too large. Maximum upload size is 3 MB.';
  if (status === 409) return 'Maximum number of knowledge sources reached (10).';

  const msg = body?.message;
  if (!msg) return `An unexpected error occurred (${status}).`;

  // Map known error codes to friendly messages
  const code = body?.error;
  const map = {
    email_already_in_use: 'That email address is already registered.',
    invalid_credentials: 'Invalid email or password.',
    unsupported_type: 'This file type isn\'t supported yet. Please upload a .txt or .md file.',
    empty_file: 'That file appears to be empty.',
    message_too_long: 'Your message is too long. Please shorten it.',
    invalid_name: 'Bot name is required and must be under 100 characters.',
    no_knowledge: 'This bot has no knowledge yet. Add some content first.',
    rate_limited: msg,
    not_found: 'Not found.',
  };

  return map[code] || msg || `An unexpected error occurred (${status}).`;
}

/**
 * Core fetch wrapper. All requests use credentials:include for cookies.
 * Returns { ok, status, data, error } — never throws.
 */
async function request(method, path, body, isFormData = false) {
  try {
    const opts = {
      method,
      credentials: 'include',
      headers: {},
    };

    if (body !== undefined) {
      if (isFormData) {
        opts.body = body; // FormData, no Content-Type needed
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }

    const res = await fetch(BASE + path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON response
    }

    if (!res.ok) {
      const error = normaliseError(res.status, data);
      return { ok: false, status: res.status, data, error };
    }

    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    // Network error
    return { ok: false, status: 0, data: null, error: 'Network error. Please check your connection.' };
  }
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

export async function getMe() {
  return request('GET', '/api/auth/me');
}

export async function register(email, password) {
  return request('POST', '/api/auth/register', { email, password });
}

export async function login(email, password) {
  return request('POST', '/api/auth/login', { email, password });
}

export async function logout() {
  return request('POST', '/api/auth/logout');
}

// --------------------------------------------------------------------------
// Bots
// --------------------------------------------------------------------------

export async function getBots() {
  return request('GET', '/api/bots');
}

export async function createBot(name, description, system_prompt) {
  return request('POST', '/api/bots', { name, description, system_prompt });
}

export async function getBot(id) {
  return request('GET', `/api/bots/${encodeURIComponent(id)}`);
}

export async function updateBot(id, fields) {
  return request('PATCH', `/api/bots/${encodeURIComponent(id)}`, fields);
}

export async function deleteBot(id) {
  return request('DELETE', `/api/bots/${encodeURIComponent(id)}`);
}

export async function publishBot(id) {
  return request('POST', `/api/bots/${encodeURIComponent(id)}/publish`, { confirmed: true });
}

export async function unpublishBot(id) {
  return request('POST', `/api/bots/${encodeURIComponent(id)}/unpublish`, {});
}

// --------------------------------------------------------------------------
// Knowledge
// --------------------------------------------------------------------------

export async function getKnowledge(botId) {
  return request('GET', `/api/bots/${encodeURIComponent(botId)}/knowledge`);
}

export async function uploadKnowledge(botId, file) {
  const fd = new FormData();
  fd.append('file', file);
  return request('POST', `/api/bots/${encodeURIComponent(botId)}/knowledge`, fd, true);
}

export async function deleteKnowledge(botId, sourceId) {
  return request('DELETE', `/api/bots/${encodeURIComponent(botId)}/knowledge/${encodeURIComponent(sourceId)}`);
}

// --------------------------------------------------------------------------
// Preview chat
// --------------------------------------------------------------------------

export async function previewChat(botId, message) {
  return request('POST', `/api/bots/${encodeURIComponent(botId)}/chat`, { message });
}
