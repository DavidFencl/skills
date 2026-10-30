// Plausible, fictional values chosen from a field's name and the type that holds it. Deterministic:
// the same field and list index always give the same value, so reruns and both sides match.
import { placeholderSvg } from './mocks.mjs';

const FIRST = ['Maria', 'Jonas', 'Eva', 'Lukas', 'Sofia', 'Tomas', 'Anna', 'Felix', 'Klara', 'Noah'];
const LAST = ['Jensen', 'Novak', 'Keller', 'Larsen', 'Horvat', 'Dubois', 'Berg', 'Kowalski', 'Varga', 'Peeters'];
const CITIES = ['Ghent', 'Brno', 'Lyon', 'Aarhus', 'Graz', 'Ljubljana', 'Krakow', 'Utrecht', 'Malmo', 'Zagreb'];
const COUNTRIES = ['Belgium', 'Czech Republic', 'France', 'Denmark', 'Austria', 'Slovenia', 'Poland', 'Netherlands', 'Sweden', 'Croatia'];
const COUNTRY_CODES = ['BE', 'CZ', 'FR', 'DK', 'AT', 'SI', 'PL', 'NL', 'SE', 'HR'];
const VENUES = ['Riverside Park', 'Old Town Square', 'North Harbour', 'City Stadium', 'Lakeside Trail', 'Central Station', 'Botanical Garden', 'Market Hall'];
const ORGS = ['Northside Athletic Club', 'Riverside Association', 'Lakeview Society', 'Harbour Collective', 'Summit Group', 'Greenway Club', 'Old Mill Union', 'Westgate Partners'];
const EVENT_TITLES = ['Spring Classic', 'Autumn Open', 'Riverside Cup', 'Winter Trophy', 'Summer Festival', 'City Championship', 'Harbour Challenge', 'Twilight Series'];
const PRODUCTS = ['Starter Plan', 'Team Plan', 'Annual Pass', 'Day Ticket', 'Premium Bundle', 'Gift Card', 'Workshop Seat', 'Family Pack'];
const SENTENCES = [
  'A friendly session for every level, with a short warm-up and a cool-down stretch at the end.',
  'Meet at the main entrance ten minutes early. Bring water and dress for the weather.',
  'Updated schedule with an extra stop at the harbour, and the route now avoids the closed bridge.',
  'Thanks for the quick reply. Everything worked as expected after the update.',
  'This longer description is here so layouts can show how they wrap text across several lines on narrow screens without breaking.',
];

const PERSON = new Set(['user', 'member', 'author', 'owner', 'person', 'participant', 'judge', 'customer', 'contact', 'employee', 'driver', 'runner', 'player', 'coach', 'viewer', 'profile', 'account', 'attendee', 'speaker', 'host', 'guest', 'buyer', 'seller', 'patient', 'student', 'teacher', 'reviewer', 'assignee', 'creator', 'sender', 'recipient', 'handler', 'breeder']);
const PLACE = new Set(['location', 'city', 'town', 'venue', 'place', 'region', 'area', 'site', 'track', 'stadium', 'park']);
const ORG = new Set(['club', 'company', 'organization', 'organisation', 'team', 'association', 'org', 'organizer', 'organiser', 'vendor', 'brand', 'school', 'business', 'agency', 'federation', 'league']);
const EVENT = new Set(['event', 'race', 'run', 'competition', 'tournament', 'match', 'meetup', 'meeting', 'session', 'class', 'course', 'workshop', 'show', 'game', 'championship', 'cup']);
const PRODUCT = new Set(['product', 'item', 'plan', 'package', 'ticket', 'service', 'offer', 'subscription', 'bundle']);
const IMAGE = new Set(['image', 'img', 'avatar', 'photo', 'picture', 'pic', 'logo', 'thumbnail', 'thumb', 'icon', 'cover', 'banner', 'hero', 'poster']);
const TEXT = new Set(['description', 'summary', 'bio', 'about', 'message', 'comment', 'comments', 'note', 'notes', 'text', 'content', 'body', 'details', 'reason', 'excerpt', 'caption', 'intro', 'subtitle']);
const NEGATIVE = new Set(['disabled', 'deleted', 'archived', 'hidden', 'blocked', 'locked', 'banned', 'suspended', 'error', 'errors', 'failed', 'failure', 'expired', 'cancelled', 'canceled', 'maintenance', 'readonly', 'draft', 'muted', 'full', 'overdue', 'invalid', 'broken', 'offline', 'deprecated', 'test', 'demo', 'debug']);
const PAST = new Set(['created', 'updated', 'modified', 'registered', 'joined', 'published', 'posted', 'last', 'since', 'signed', 'submitted', 'received', 'sent', 'issued', 'completed', 'finished', 'paid', 'verified', 'approved', 'seen', 'read', 'login', 'logged', 'member']);
const BIRTH = new Set(['birth', 'born', 'dob', 'birthday', 'birthdate']);

export function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

// The noun a value describes: "eventName" → event, "EventPreviewDto" → event, "items" in "EventPage" → event.
export function nounOf(key, owner) {
  const own = words(key).filter((word) => !['name', 'title', 'label', 'id', 'url', 'ref', 'is', 'has'].includes(word));
  if (own.length) return singular(own[0]);
  const type = words(owner ?? '').filter((word) => !['dto', 'model', 'response', 'request', 'entity', 'item', 'preview', 'detail', 'details', 'data', 'result', 'summary', 'view', 'info', 'type', 'schema', 'props', 'query', 'page', 'list'].includes(word));
  return singular(type[0] ?? 'item');
}

function singular(word) {
  return word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('ses') || word.endsWith('xes') ? word.slice(0, -2) : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

const pick = (list, index) => list[((index % list.length) + list.length) % list.length];
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const personIndex = (ctx) => ctx.index + (ctx.depth ?? 0) * 3;

// A data URI needs no host, so it renders whether or not allowHosts blocks image CDNs.
export function imageUrl(key) {
  const tokens = new Set(words(key));
  const square = ['avatar', 'icon', 'logo', 'thumbnail', 'thumb'].some((word) => tokens.has(word));
  const wide = ['cover', 'banner', 'hero', 'poster'].some((word) => tokens.has(word));
  return `data:image/svg+xml,${encodeURIComponent(placeholderSvg({ width: square ? 96 : wide ? 1200 : 640, height: square ? 96 : wide ? 480 : 400 }))}`;
}

// Different fields of the same item should not all get the same number.
function keyOffset(key) {
  let sum = 0;
  for (const char of String(key)) sum = (sum * 31 + char.charCodeAt(0)) % 997;
  return sum;
}

export function isDateName(key) {
  const tokens = words(key);
  const last = tokens.at(-1);
  return ['date', 'time', 'timestamp', 'deadline', 'datetime', 'at', 'on', 'since', 'birthday', 'dob', 'expires', 'expiry'].includes(last) || tokens.includes('date') || (tokens[0] && BIRTH.has(tokens[0]));
}

export function dateFor(ctx) {
  const tokens = words(ctx.key);
  const now = ctx.now ?? new Date();
  const day = 24 * 3600 * 1000;
  let time;
  if (tokens.some((word) => BIRTH.has(word))) {
    const years = PERSON.has(nounOf('', ctx.owner)) ? 31 + ctx.index * 3 : 4 + ctx.index;
    time = Date.UTC(now.getUTCFullYear() - years, (3 + ctx.index * 2) % 12, 12 + ctx.index);
  } else if (tokens.some((word) => ['since', 'joined', 'registered', 'member'].includes(word))) {
    time = Date.UTC(now.getUTCFullYear() - 1 - (ctx.index % 4), (2 + ctx.index * 5) % 12, 1 + ctx.index * 3);
  } else if (tokens.some((word) => PAST.has(word))) {
    time = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (ctx.index + 1) * 3, 14 - (ctx.index % 5), ctx.index % 2 ? 30 : 15);
  } else {
    // Starts, deadlines and plain dates are upcoming: a few days apart, during the day.
    const start = new Date(now.getTime() + (ctx.index + 1) * 2 * day);
    time = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 8 + ((ctx.index * 3) % 10), ctx.index % 2 ? 30 : 0);
    if (tokens.includes('end') || tokens.includes('ends') || tokens.includes('until')) time += 2 * 3600 * 1000;
  }
  return new Date(time).toISOString();
}

export function stringFor(ctx) {
  const { key, owner, index } = ctx;
  const tokens = words(key);
  const has = (...names) => names.some((name) => tokens.includes(name));
  const last = tokens.at(-1) ?? '';
  const noun = nounOf(key, owner);
  const person = personIndex(ctx);
  if (has('email', 'mail')) return `${pick(FIRST, person)}.${pick(LAST, person)}@example.com`.toLowerCase();
  if (has('phone', 'mobile', 'tel', 'telephone')) return `+1 555 01${String(index % 100).padStart(2, '0')}`;
  if (tokens.some((word) => IMAGE.has(word))) return imageUrl(key);
  if (has('url', 'href', 'link', 'website', 'homepage', 'uri')) return `https://example.com/${noun}s/${index + 1}`;
  if (has('uuid', 'guid')) return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  if (last === 'id' || last === 'ref' || last === 'key' || key === '_id') return `${noun === 'item' ? nounOf('', owner) : noun}-${index + 1}`;
  if (last === 'slug') return pick(EVENT_TITLES, index).toLowerCase().replace(/\s+/g, '-');
  if (isDateName(key)) return dateFor(ctx);
  if (has('first') && has('name')) return pick(FIRST, person);
  if ((has('last') && has('name')) || has('surname')) return pick(LAST, person);
  if (has('username', 'login', 'handle', 'nickname')) return `${pick(FIRST, person)}.${pick(LAST, person)}`.toLowerCase();
  if (has('initials')) return `${pick(FIRST, person)[0]}${pick(LAST, person)[0]}`;
  if (has('country') && has('code')) return pick(COUNTRY_CODES, index);
  if (has('country', 'nationality')) return pick(COUNTRIES, index);
  if (has('city', 'town')) return pick(CITIES, index);
  if (has('street', 'address', 'line1')) return `${12 + index * 7} River Street`;
  if (has('zip', 'postal', 'postcode')) return String(10115 + index * 11);
  if (has('currency')) return 'EUR';
  if (has('locale', 'language', 'lang')) return 'en';
  if (has('timezone', 'tz')) return 'Europe/Brussels';
  if (has('color', 'colour')) return pick(['#2563eb', '#16a34a', '#d97706', '#db2777'], index);
  if (has('version')) return `1.${4 + index}.0`;
  if (has('ip')) return `192.0.2.${10 + index}`;
  if (has('token', 'secret', 'password', 'hash', 'jwt', 'apikey', 'signature')) return `mock-${tokens.join('-')}-${index + 1}`;
  if (has('path')) return `/${noun}s/${index + 1}`;
  if (has('filename', 'file')) return `${noun}-${index + 1}.pdf`;
  if (has('mime', 'mimetype')) return 'application/pdf';
  if (tokens.some((word) => TEXT.has(word))) return pick(SENTENCES, index);
  if (has('status', 'state')) return pick(['active', 'pending', 'completed'], index);
  if (has('role')) return pick(['member', 'admin', 'viewer'], index);
  if (has('type', 'kind', 'category')) return pick(['standard', 'special', 'standard'], index);
  if (has('level', 'difficulty')) return pick(['beginner', 'intermediate', 'advanced'], index);
  if (has('name', 'title', 'label', 'heading', 'caption', 'display')) {
    const subject = noun === 'item' || noun === 'display' ? nounOf('', owner) : noun;
    if (PERSON.has(subject) || (has('display') && has('name')) || (has('full') && has('name'))) return `${pick(FIRST, person)} ${pick(LAST, person)}`;
    if (PLACE.has(subject)) return pick(VENUES, index);
    if (ORG.has(subject)) return pick(ORGS, index);
    if (EVENT.has(subject)) return pick(EVENT_TITLES, index);
    if (PRODUCT.has(subject)) return pick(PRODUCTS, index);
    return `${capitalize(subject)} ${pick(['Alpha', 'Bravo', 'Delta', 'Echo', 'Nova', 'Orbit'], index)}`;
  }
  return `${capitalize(tokens.join(' ') || 'value')} ${index + 1}`;
}

export function numberFor(ctx) {
  const { key, index, items = 3 } = ctx;
  const tokens = words(key);
  const has = (...names) => names.some((name) => tokens.includes(name));
  const last = tokens.at(-1) ?? '';
  if (last === 'id' || key === 'id') return index + 1;
  if (has('lat', 'latitude')) return Number((50.85 + index * 0.012).toFixed(4));
  if (has('lng', 'lon', 'long', 'longitude')) return Number((4.35 + index * 0.015).toFixed(4));
  if (has('page', 'offset', 'skip') && !has('size', 'count')) return 0;
  if (has('limit', 'size', 'take') || (has('per') && has('page'))) return items;
  if (has('total') && (has('count', 'items', 'pages', 'results', 'elements') || tokens.length === 1)) return has('pages') ? 1 : items;
  if (has('price', 'cost', 'fee', 'amount', 'balance', 'salary', 'revenue', 'subtotal', 'tax', 'discount')) return 25 + index * 10;
  if (has('percent', 'percentage', 'pct')) return 42 + index * 9;
  if (has('ratio', 'rate', 'share', 'progress', 'probability')) return Number((0.42 + index * 0.11).toFixed(2));
  // "year" is a calendar year, but "eventsThisYear" counts events.
  if (last === 'year' && !(tokens[0].endsWith('s') && tokens.length > 1) && !has('this', 'per')) return (ctx.now ?? new Date()).getUTCFullYear();
  if (has('month')) return ((ctx.now ?? new Date()).getUTCMonth() + 1 + index) % 12 || 12;
  if (has('age')) return 4 + index;
  if (has('rank', 'position', 'place', 'order', 'index', 'seq', 'sort', 'priority')) return index + 1;
  if (has('rating', 'stars')) return Number((4.6 - index * 0.3).toFixed(1));
  if (has('score', 'points', 'grade')) return 87 - index * 6;
  if (has('km', 'distance', 'miles', 'kilometers', 'kilometres', 'meters', 'metres')) return [5, 9.5, 21, 12, 42.2][index % 5];
  if (has('width')) return 640;
  if (has('height')) return 480;
  if (has('weight', 'kg')) return Number((28.5 + index * 1.5).toFixed(1));
  if (has('ms', 'milliseconds')) return 1200 + index * 150;
  if (has('seconds', 'duration', 'elapsed', 'time')) return Number((32.4 + index * 1.7).toFixed(2));
  if (has('minutes')) return 45 + index * 15;
  if (has('days', 'remaining', 'left', 'spots', 'available', 'seats', 'capacity', 'stock')) return Math.max(0, 18 - index * 6);
  if (has('count', 'number', 'num', 'qty', 'quantity', 'members', 'views', 'likes', 'followers') || (tokens.length > 1 && tokens[0].endsWith('s'))) return [24, 128, 46, 8, 905, 312, 17][(index + keyOffset(key)) % 7] * (tokens.includes('total') ? 10 : 1);
  return (index + 1) * 3;
}

export function booleanFor(ctx) {
  const tokens = [...words(ctx.key), ...words(ctx.owner ?? '')];
  const own = words(ctx.key);
  if (own.includes('first')) return ctx.index === 0;
  if (own.includes('last')) return true;
  if (own.includes('more') || own.includes('next') || (own.includes('has') && own.includes('previous'))) return false;
  if (tokens.some((word) => NEGATIVE.has(word))) return false;
  return ctx.inArray ? ctx.index % 3 !== 2 : true;
}
