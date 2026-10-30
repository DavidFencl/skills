// @ts-check
import { getViewer, subscribePresence } from '../api.js';
import { el } from './dom.js';

export function renderHeader() {
  const viewer = el('div', { class: 'viewer viewer--loading' }, 'Loading…');
  const online = el('span', { class: 'online', hidden: '' });
  const header = el(
    'header',
    { class: 'site-header' },
    el('a', { class: 'brand', href: '/' }, el('span', { class: 'brand__mark', 'aria-hidden': 'true' }, 'RR'), 'Riverside Running Club'),
    el('nav', { class: 'site-nav' }, el('a', { href: '/' }, 'Events'), el('a', { href: '/routes' }, 'Routes'), el('a', { href: '/about' }, 'About')),
    online,
    viewer,
  );

  getViewer()
    .then(({ data }) => {
      viewer.className = 'viewer';
      viewer.replaceChildren(el('img', { class: 'viewer__avatar', src: data.viewer.avatarUrl, alt: '' }), el('span', {}, data.viewer.displayName));
    })
    .catch(() => {
      viewer.className = 'viewer viewer--error';
      viewer.textContent = 'Sign-in unavailable';
    });

  subscribePresence((message) => {
    if (message.type !== 'presence') return;
    online.hidden = false;
    online.textContent = `${message.online} runners online`;
  });
  return header;
}
