// @ts-check
import { el } from './dom.js';

/** @typedef {import('../types.js').RunEvent} RunEvent */

const DIFFICULTY_LABEL = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard' };

/** @param {RunEvent} event */
export function renderEventCard(event) {
  const start = new Date(event.startsAt);
  const day = start.toLocaleDateString('en-GB', { day: '2-digit', timeZone: 'UTC' });
  const month = start.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const time = start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return el(
    'article',
    { class: `event-card${event.isFull ? ' event-card--full' : ''}` },
    el('div', { class: 'event-card__date' }, el('span', { class: 'event-card__day' }, day), el('span', { class: 'event-card__month' }, month)),
    el(
      'div',
      { class: 'event-card__body' },
      el('h3', { class: 'event-card__title' }, event.title),
      el('p', { class: 'event-card__meta' }, `${event.city} · ${time} · ${event.distanceKm} km`),
      el(
        'div',
        { class: 'event-card__tags' },
        el('span', { class: `pill pill--${event.difficulty}` }, DIFFICULTY_LABEL[event.difficulty]),
        el('span', { class: 'event-card__spots' }, event.isFull ? 'Fully booked' : `${event.spotsLeft} spots left`),
      ),
    ),
    el('button', { class: 'button event-card__join', type: 'button', ...(event.isFull ? { disabled: '' } : {}) }, event.isFull ? 'Waitlist' : 'Join'),
  );
}
