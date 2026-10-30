// @ts-check
/** @typedef {import('./types.js').EventPage} EventPage */
/** @typedef {import('./types.js').ClubStats} ClubStats */
/** @typedef {import('./types.js').ViewerQueryResult} ViewerQueryResult */
/** @typedef {import('./types.js').PresenceMessage} PresenceMessage */

const API_URL = /** @type {any} */ (window).APP_CONFIG.apiUrl;
const LOCALE = navigator.language.split('-')[0] || 'en';

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(path, init) {
  const url = new URL(`${API_URL}${path}`);
  url.searchParams.set('locale', LOCALE);
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** @returns {Promise<EventPage>} */
export async function getUpcomingEvents() {
  return request('/events/upcoming');
}

/** @returns {Promise<ClubStats>} */
export async function getClubStats() {
  return request('/stats/club');
}

/** @returns {Promise<ViewerQueryResult>} */
export async function getViewer() {
  return request('/graphql', {
    method: 'POST',
    body: JSON.stringify({ operationName: 'Viewer', query: 'query Viewer { viewer { id displayName avatarUrl memberSince } }', variables: {} }),
  });
}

/**
 * Live presence updates from the club WebSocket.
 * @param {(message: PresenceMessage) => void} onMessage
 */
export function subscribePresence(onMessage) {
  const socket = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/live`);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', channel: 'presence' })));
  socket.addEventListener('message', (event) => onMessage(JSON.parse(event.data)));
  return () => socket.close();
}
