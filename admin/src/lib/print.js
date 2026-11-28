// Printing a small document of its own (a slip, a bill) through the browser, so any printer set up on the device works.

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Opens the device's print window for a complete HTML page, written into a hidden frame so the screen stays as it is. */
export function printPage(html, title) {
  if (typeof document === 'undefined') return false;
  const frame = document.createElement('iframe');
  frame.title = title;
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const page = frame.contentDocument;
  page.open();
  page.write(html);
  page.close();
  const view = frame.contentWindow;
  view.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 1000), { once: true });
  setTimeout(() => {
    view.focus();
    view.print();
  }, 150);
  setTimeout(() => frame.remove(), 5 * 60_000); // in case the browser never says it has finished
  return true;
}
