/**
 * PreBase Toast Notification Utility
 * Pure DOM implementation, safe from circular app shell dependencies.
 */

export function showToast(message, type = 'default') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast' + (type !== 'default' ? ` ${type}` : '');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
