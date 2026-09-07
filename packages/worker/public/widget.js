(function () {
  'use strict';

  // 1. Find this script tag to get attributes and the origin URL.
  const currentScript = document.currentScript || (function() {
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  if (!currentScript) {
    console.error('[PreBase] Could not find widget script element.');
    return;
  }

  const botId = currentScript.getAttribute('data-bot-id');
  if (!botId) {
    console.error('[PreBase] Missing data-bot-id on script tag.');
    return;
  }

  const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!BOT_ID_RE.test(botId)) {
    console.error('[PreBase] Invalid bot ID format.');
    return;
  }

  // Get the base URL from the script src so the iframe points to the correct backend
  const scriptUrl = new URL(currentScript.src);
  const baseUrl = scriptUrl.origin;
  const frameUrl = `${baseUrl}/frame?bot=${encodeURIComponent(botId)}`;

  // 2. Create the host container for Shadow DOM to ensure CSS isolation
  const container = document.createElement('div');
  // Use a random ID to avoid conflicts if embedded multiple times with different bots
  const containerId = 'prebase-widget-' + Math.random().toString(36).substring(2, 9);
  container.id = containerId;
  
  // Position the container fixed at the bottom right.
  // This styles the HOST element of the shadow DOM.
  Object.assign(container.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '2147483647', // Max z-index to stay on top
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    pointerEvents: 'none' // Let clicks pass through the container itself
  });

  document.body.appendChild(container);

  // 3. Attach Shadow DOM
  const shadow = container.attachShadow({ mode: 'closed' });

  // 4. Inject isolated CSS into Shadow DOM
  const style = document.createElement('style');
  style.textContent = `
    :host {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --text: #ffffff;
      --shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      font-family: system-ui, -apple-system, sans-serif;
    }

    /* Reset within shadow DOM */
    *, *::before, *::after {
      box-sizing: border-box;
    }

    #launcher {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background-color: var(--primary);
      color: var(--text);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--shadow);
      transition: transform 0.2s, background-color 0.2s;
      pointer-events: auto; /* Enable clicks on the button */
      margin-top: 16px;
    }

    #launcher:hover {
      background-color: var(--primary-hover);
      transform: scale(1.05);
    }

    #launcher svg {
      width: 28px;
      height: 28px;
      fill: currentColor;
    }

    #iframe-container {
      width: 380px;
      height: 600px;
      max-width: calc(100vw - 40px); /* Responsive padding */
      max-height: calc(100vh - 120px);
      background: white;
      border-radius: 12px;
      box-shadow: var(--shadow);
      overflow: hidden;
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.3s ease, transform 0.3s ease;
      pointer-events: none;
      display: flex;
    }

    #iframe-container.open {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }

    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: transparent;
    }

    /* Responsive adjustments for mobile */
    @media (max-width: 480px) {
      #iframe-container {
        width: calc(100vw - 40px);
        height: calc(100vh - 120px);
      }
    }
  `;

  // 5. Create UI elements
  const iframeContainer = document.createElement('div');
  iframeContainer.id = 'iframe-container';

  const iframe = document.createElement('iframe');
  iframe.src = frameUrl;
  iframe.title = 'PreBase Chat Widget';
  // Strict sandbox: allow scripts for UI logic and allow-same-origin for API calls
  // to avoid needing wildcard CORS on the API endpoints. allow-forms is no longer
  // required since submission is handled by JS keydown/click events.
  iframe.sandbox = 'allow-scripts allow-same-origin';
  
  iframeContainer.appendChild(iframe);

  const launcher = document.createElement('button');
  launcher.id = 'launcher';
  launcher.ariaLabel = 'Open Chat';
  // Chat bubble SVG icon
  launcher.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>';

  // 6. Build the DOM inside Shadow Root
  shadow.appendChild(style);
  shadow.appendChild(iframeContainer);
  shadow.appendChild(launcher);

  // 7. Interaction Logic
  let isOpen = false;

  function toggleChat() {
    isOpen = !isOpen;
    if (isOpen) {
      iframeContainer.classList.add('open');
      launcher.ariaLabel = 'Close Chat';
      // Switch icon to X
      launcher.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>';
      // Post message to iframe that it opened so it can focus the input
      iframe.contentWindow?.postMessage({ type: 'PREBASE_WIDGET_OPEN' }, '*');
    } else {
      iframeContainer.classList.remove('open');
      launcher.ariaLabel = 'Open Chat';
      // Switch icon back to bubble
      launcher.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>';
    }
  }

  launcher.addEventListener('click', toggleChat);

  // Listen for messages from the iframe
  window.addEventListener('message', (event) => {
    // Basic origin check (allow any if we don't have a strict baseUrl, but we do)
    // iframe sandbox without allow-same-origin makes the origin "null". So we must accept "null" or baseUrl.
    if (event.origin !== baseUrl && event.origin !== 'null' && event.origin !== '') return;
    
    if (event.data && event.data.type === 'PREBASE_WIDGET_CLOSE') {
      if (isOpen) toggleChat();
    }
  });

})();
