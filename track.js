'use strict';

// Анонимный журнал действий для автора сайта: только коды действий, без личных данных и IP.
// Сервер сам превращает код в текст и присылает сводку в Telegram.
// Автор может отключить учёт для своего браузера ссылкой /?notrack=1, включить обратно: /?notrack=0

const TRACK_SESSION = 'dota-session';
const TRACK_OFF = 'dota-no-track';

const track = { id: '', last: '' };

function trackSend(action, value = '') {
  if (!track.id || !SERVER_MODE) return;
  const key = `${action}:${value}`;
  if (key === track.last) return;
  track.last = key;
  const body = JSON.stringify({ id: track.id, action, value: String(value) });
  try {
    if (navigator.sendBeacon(`${location.origin}/api/track`, new Blob([body], { type: 'application/json' }))) return;
  } catch (e) {}
  fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

// Оборачиваем готовые функции, чтобы учёт не был разбросан по коду сайта
function trackWrap(name, action, value = () => '') {
  const original = window[name];
  if (typeof original !== 'function') return;
  window[name] = function wrapped(...args) {
    const shown = value(...args);
    if (shown !== null) trackSend(action, shown);
    return original.apply(this, args);
  };
}

function trackSource() {
  try {
    const host = new URL(document.referrer).hostname.toLowerCase();
    return host === location.hostname ? '' : host;
  } catch (e) {
    return '';
  }
}

function trackIsOff() {
  try {
    const flag = new URLSearchParams(location.search).get('notrack');
    if (flag === '1') localStorage.setItem(TRACK_OFF, '1');
    if (flag === '0') localStorage.removeItem(TRACK_OFF);
    return localStorage.getItem(TRACK_OFF) === '1';
  } catch (e) {
    return false;
  }
}

function trackSessionId() {
  try {
    const saved = sessionStorage.getItem(TRACK_SESSION);
    if (/^[a-f0-9]{8}$/.test(saved || '')) return { id: saved, fresh: false };
  } catch (e) {}
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const id = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(TRACK_SESSION, id);
  } catch (e) {}
  return { id, fresh: true };
}

function trackStart() {
  if (!SERVER_MODE || trackIsOff()) return;
  const session = trackSessionId();
  track.id = session.id;
  if (session.fresh) trackSend('open', `${matchMedia('(pointer: coarse)').matches ? 'phone' : 'pc'}|${trackSource()}`);

  trackWrap('switchTab', 'tab', tab => tab);
  trackWrap('proOnReplay', 'match', m => (m && m.match_id ? m.match_id : null));
  trackWrap('mhOpen', 'hero', (heroId, scroll = true) => (scroll ? getHeroName(heroId) : null));
  trackWrap('mhLoadErrors', 'hero_errors', heroId => getHeroName(heroId));
  trackWrap('statsOpenHero', 'hero_page', heroId => getHeroName(heroId));
  trackWrap('draftAdd', 'draft', heroId => getHeroName(heroId));
  trackWrap('replayToggle', 'map_play', () => (replay.playing ? null : ''));
  trackWrap('replayOpenMoment', 'moment');
  trackWrap('replayGoTo', 'turn');
  trackWrap('statsLoadOverview', 'overview');
  trackWrap('proLoadHabits', 'habits');
  trackWrap('proCompare', 'compare');
  trackWrap('proShareCard', 'card');
  trackWrap('chatOpen', 'chat');
}

window.addEventListener('DOMContentLoaded', trackStart);
