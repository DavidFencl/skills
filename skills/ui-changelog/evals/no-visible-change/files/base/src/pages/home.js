// @ts-check
import { getClubStats, getUpcomingEvents } from '../api.js';
import { el } from '../components/dom.js';
import { renderEventCard } from '../components/event-card.js';

export function renderHomePage() {
  const stats = el('div', { class: 'stats' }, ...['Members', 'Events this year', 'Kilometres run', 'Countries'].map((label) => statTile('–', label)));
  const list = el('div', { class: 'event-list' }, ...[1, 2, 3].map(() => el('div', { class: 'event-card event-card--skeleton' })));

  getClubStats()
    .then((data) => {
      stats.replaceChildren(
        statTile(data.memberCount.toLocaleString('en-GB'), 'Members'),
        statTile(String(data.eventsThisYear), 'Events this year'),
        statTile(data.kilometersRun.toLocaleString('en-GB'), 'Kilometres run'),
        statTile(String(data.countryCount), 'Countries'),
      );
    })
    .catch(() => stats.replaceChildren(el('p', { class: 'error' }, 'Club stats could not be loaded.')));

  getUpcomingEvents()
    .then((page) => list.replaceChildren(...(page.items.length ? page.items.map(renderEventCard) : [el('p', { class: 'empty' }, 'No upcoming runs. Check back soon!')])))
    .catch(() => list.replaceChildren(el('p', { class: 'error' }, 'Upcoming runs could not be loaded. Please try again later.')));

  return el(
    'main',
    { class: 'home' },
    el('section', { class: 'hero' }, el('h1', {}, 'Run together along the river'), el('p', {}, 'Weekly group runs for every pace, from gentle 5 km loops to long Sunday trail runs.'), stats),
    el('section', { class: 'upcoming' }, el('h2', {}, 'Upcoming runs'), list),
  );
}

/**
 * @param {string} value
 * @param {string} label
 */
function statTile(value, label) {
  return el('div', { class: 'stat' }, el('strong', {}, value), el('span', {}, label));
}
