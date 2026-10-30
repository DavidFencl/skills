// Exercises every kind of mock and network guard. Each result lands in an element the test waits for.
const API = 'http://127.0.0.1:47098/api';
const out = (id, text) => {
  document.getElementById(id).textContent = String(text);
};
const json = (response) => response.json();
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'mocks';

out('init', window.__UI_CHANGELOG_INIT__ ?? 'none');

if (scenario === 'mocks') {
  import('/src/api/client.js').then((module) => out('module', module.ok ? 'module ok' : 'module wrong')).catch(() => out('module', 'module broken'));
  fetch(`${API}/items?page=2&sort=new`).then(json).then((data) => out('query', data.label)).catch(() => out('query', 'error'));
  fetch(`${API}/graphql`, { method: 'POST', body: JSON.stringify({ operationName: 'First', query: 'query First { a }' }) }).then(json).then((data) => out('gqlA', data.data.a));
  fetch(`${API}/graphql`, { method: 'POST', body: JSON.stringify({ query: 'query Second { b }' }) }).then(json).then((data) => out('gqlB', data.data.b));
  fetch(`${API}/notes`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) })
    .then(() => fetch(`${API}/notes`))
    .then(json)
    .then((data) => out('stateful', data.notes.join(',')));
  const events = new EventSource(`${API}/stream`);
  events.addEventListener('tick', (event) => out('sse', `tick ${JSON.parse(event.data).n}`));
  const socket = new WebSocket('ws://127.0.0.1:47098/api/live');
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe' })));
  socket.addEventListener('message', (event) => out('ws', `${document.getElementById('ws').textContent} ${event.data}`.trim()));
  fetch(`${API}/slow`).then(() => out('pending', 'answered'));
  out('pending', 'loading');
} else {
  fetch('https://analytics.example.invalid/collect').then(() => out('thirdparty', 'reached'), () => out('thirdparty', 'blocked'));
  const outside = new WebSocket('wss://socket.example.invalid/feed');
  outside.addEventListener('close', () => out('thirdws', 'closed'));
  const image = document.getElementById('img');
  image.addEventListener('load', () => out('imgstate', `loaded ${image.naturalWidth}`));
  image.addEventListener('error', () => out('imgstate', 'error'));
  image.src = 'https://cdn.example.invalid/picture.png';
  fetch('/api/settings').then((response) => response.text()).then((text) => out('fallback', text.trimStart().startsWith('<!doctype') ? 'html' : 'data'));
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    setTimeout(() => out('sw', navigator.serviceWorker.controller ? 'controlling' : 'not controlling'), 1500);
  } else out('sw', 'unavailable');
  console.error('custom console error from the app');
  setTimeout(() => {
    throw new Error('boom from the app');
  }, 10);
}
