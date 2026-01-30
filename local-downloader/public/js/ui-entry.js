import { initUI } from './ui.js';

// Initialize the UI once the DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initUI();
  });
} else {
  initUI();
}
