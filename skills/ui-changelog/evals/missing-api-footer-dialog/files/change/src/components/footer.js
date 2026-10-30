// @ts-check
import { el } from './dom.js';
import { openReportDialog } from './report-dialog.js';

export function renderFooter() {
  const { version } = /** @type {any} */ (window).APP_CONFIG;
  const report = el('button', { class: 'site-footer__report', type: 'button', 'data-testid': 'report-problem' }, 'Report a problem');
  report.addEventListener('click', () => openReportDialog());
  return el(
    'footer',
    { class: 'site-footer' },
    el(
      'div',
      { class: 'site-footer__columns' },
      column('Club', [link('About us', '/about'), link('Coaches', '/coaches'), link('Membership', '/membership')]),
      column('Runs', [link('Calendar', '/'), link('Routes', '/routes'), link('Results', '/results')]),
      column('Contact', [link('hello@riverside-run.example', 'mailto:hello@riverside-run.example'), link('Instagram', 'https://instagram.com/'), report]),
    ),
    el('p', { class: 'site-footer__legal' }, el('span', {}, '© 2026 Riverside Running Club'), el('span', { class: 'site-footer__version' }, `Version ${version}`)),
  );
}

/**
 * @param {string} title
 * @param {HTMLElement[]} items
 */
function column(title, items) {
  return el('div', { class: 'site-footer__column' }, el('h4', {}, title), ...items);
}

/**
 * @param {string} label
 * @param {string} href
 */
function link(label, href) {
  return el('a', { href }, label);
}
