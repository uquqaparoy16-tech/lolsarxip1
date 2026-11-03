'use strict';

// Свой фон сайта. Картинка хранится только в браузере посетителя и на сервер не уходит.
// Автор может задать фон для всех: файл background.jpg в корне сайта. Фон посетителя важнее.

const THEME_SETTINGS = 'dota-theme';
const THEME_DB = 'dota-theme';
const THEME_STORE = 'files';
const THEME_KEY = 'background';
const THEME_DEFAULT_IMAGE = '/background.jpg';
const THEME_MAX_SIDE = 2200;
const THEME_MAX_INPUT_BYTES = 25 * 1024 * 1024;
const THEME_QUALITY = 0.85;
const THEME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const THEME_DEFAULTS = { dim: 55, blur: 0, cards: 82 };

const theme = { ...THEME_DEFAULTS, url: '', own: false };

function themeReadSettings() {
  const saved = proRead(THEME_SETTINGS, null);
  if (!saved) return;
  Object.keys(THEME_DEFAULTS).forEach(key => {
    const value = Number(saved[key]);
    if (Number.isFinite(value)) theme[key] = value;
  });
}

function themeOpenDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(THEME_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(THEME_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function themeStore(mode, action) {
  const db = await themeOpenDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(THEME_STORE, mode);
    const request = action(transaction.objectStore(THEME_STORE));
    transaction.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

function themeApply() {
  const box = document.getElementById('site-bg');
  const has = !!theme.url;
  document.body.classList.toggle('has-bg', has);
  box.classList.toggle('hidden', !has);
  document.getElementById('site-bg-image').style.backgroundImage = has ? `url("${theme.url}")` : '';
  document.getElementById('site-bg-image').style.filter = theme.blur > 0 ? `blur(${theme.blur}px)` : '';
  document.getElementById('site-bg-dim').style.opacity = String(theme.dim / 100);

  const root = document.documentElement.style;
  const cards = theme.cards / 100;
  if (has) {
    root.setProperty('--surface', `rgba(14, 16, 22, ${cards})`);
    root.setProperty('--surface-2', `rgba(24, 27, 35, ${Math.min(1, cards + 0.1)})`);
  } else {
    root.removeProperty('--surface');
    root.removeProperty('--surface-2');
  }
  document.getElementById('theme-reset').classList.toggle('hidden', !theme.own);
}

function themeShowUrl(url, own) {
  if (theme.own && theme.url.startsWith('blob:')) URL.revokeObjectURL(theme.url);
  theme.url = url;
  theme.own = own;
  themeApply();
}

function themeTogglePanel() {
  document.getElementById('theme-panel').classList.toggle('hidden');
}

// Уменьшаем фото: иначе большой файл замедляет страницу и занимает много места в браузере
async function themeShrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, THEME_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('empty'))), 'image/jpeg', THEME_QUALITY);
  });
}

async function themePick(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (!THEME_TYPES.includes(file.type) || file.size > THEME_MAX_INPUT_BYTES) {
    proToast('Подойдёт JPG, PNG или WebP до 25 МБ');
    return;
  }

  let image;
  try {
    image = await themeShrink(file);
  } catch (e) {
    proToast('Не получилось открыть эту картинку');
    return;
  }
  themeShowUrl(URL.createObjectURL(image), true);
  try {
    await themeStore('readwrite', store => store.put(image, THEME_KEY));
  } catch (e) {
    proToast('Фон не сохранился: после перезагрузки он пропадёт');
  }
}

function themeSet(key, value) {
  theme[key] = Number(value);
  proWrite(THEME_SETTINGS, { dim: theme.dim, blur: theme.blur, cards: theme.cards });
  themeApply();
}

function themeLoadDefault() {
  const probe = new Image();
  probe.onload = () => {
    if (!theme.own) themeShowUrl(THEME_DEFAULT_IMAGE, false);
  };
  probe.src = THEME_DEFAULT_IMAGE;
}

async function themeReset() {
  try {
    await themeStore('readwrite', store => store.delete(THEME_KEY));
  } catch (e) {}
  themeShowUrl('', false);
  themeLoadDefault();
}

async function themeStart() {
  themeReadSettings();
  ['dim', 'blur', 'cards'].forEach(key => {
    document.getElementById(`theme-${key}`).value = theme[key];
  });
  let image = null;
  try {
    image = await themeStore('readonly', store => store.get(THEME_KEY));
  } catch (e) {}
  if (image) themeShowUrl(URL.createObjectURL(image), true);
  else if (SERVER_MODE) themeLoadDefault();
}

window.addEventListener('DOMContentLoaded', themeStart);
