'use strict';

// Чат посетителя с автором сайта. Посетитель пишет здесь, автор отвечает в Telegram.
// История лежит в браузере посетителя, сервер хранит только ответы, которые ещё не забрали.

const CHAT_STORAGE = 'dota-chat';
const CHAT_POLL_OPEN_MS = 8000;
const CHAT_POLL_IDLE_MS = 60000;
const CHAT_MAX_SAVED = 100;

const chat = {
  id: '',
  items: [],
  after: 0,
  open: false,
  unread: 0,
  timer: null,
  matchId: ''
};

function chatNewId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function chatSave() {
  proWrite(CHAT_STORAGE, { id: chat.id, after: chat.after, items: chat.items.slice(-CHAT_MAX_SAVED) });
}

function chatRestore() {
  const saved = proRead(CHAT_STORAGE, null);
  if (saved && /^[a-f0-9]{16}$/.test(saved.id)) {
    chat.id = saved.id;
    chat.after = Number(saved.after) || 0;
    chat.items = Array.isArray(saved.items) ? saved.items.filter(item => item && typeof item.text === 'string') : [];
  } else {
    chat.id = chatNewId();
  }
}

function chatRender() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  list.innerHTML = chat.items.length > 0
    ? chat.items.map(item => `<p class="chat-bubble ${item.from === 'owner' ? 'owner' : 'me'}">${esc(item.text)}</p>`).join('')
    : '<p class="text-sm text-slate-400">Напиши, что не так с разбором или что добавить на сайт. Ответ появится здесь.</p>';
  list.scrollTop = list.scrollHeight;

  const badge = document.getElementById('chat-badge');
  badge.textContent = chat.unread;
  badge.classList.toggle('hidden', chat.unread === 0);
}

function chatOpen(matchId = '') {
  chat.open = true;
  chat.matchId = matchId ? String(matchId) : chat.matchId;
  chat.unread = 0;
  document.getElementById('chat-panel').classList.remove('hidden');
  chatRender();
  chatPoll();
  document.getElementById('chat-text').focus();
}

function chatClose() {
  chat.open = false;
  document.getElementById('chat-panel').classList.add('hidden');
  chatSchedule();
}

function chatToggle() {
  if (chat.open) chatClose();
  else chatOpen();
}

async function chatSend() {
  const input = document.getElementById('chat-text');
  const button = document.getElementById('chat-send');
  const text = input.value.trim();
  if (!text) return;

  button.disabled = true;
  let sent = false;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: chat.id, text, matchId: chat.matchId })
    });
    sent = res.ok;
  } catch (e) {}
  button.disabled = false;

  if (!sent) {
    proToast('Не отправилось, попробуй через минуту');
    return;
  }
  input.value = '';
  chat.matchId = '';
  chat.items.push({ from: 'me', text });
  chatSave();
  chatRender();
}

async function chatPoll() {
  if (document.hidden || !proState.telegram) return chatSchedule();
  try {
    const res = await fetch(`/api/chat/${chat.id}?after=${chat.after}`);
    const data = res.ok ? await res.json() : null;
    const incoming = data && Array.isArray(data.messages) ? data.messages : [];
    incoming.forEach(message => {
      chat.items.push({ from: 'owner', text: String(message.text) });
      chat.after = Math.max(chat.after, Number(message.id) || 0);
      if (!chat.open) chat.unread += 1;
    });
    if (incoming.length > 0) {
      chatSave();
      chatRender();
      if (!chat.open) proToast('Автор сайта ответил тебе');
    }
  } catch (e) {}
  return chatSchedule();
}

// Опрашиваем только если человек уже писал: иначе сервер не будил бы никто лишний раз
function chatSchedule() {
  clearTimeout(chat.timer);
  if (!chat.open && chat.items.length === 0) return;
  chat.timer = setTimeout(chatPoll, chat.open ? CHAT_POLL_OPEN_MS : CHAT_POLL_IDLE_MS);
}

function chatStart() {
  const button = document.getElementById('chat-button');
  if (!button || !proState.telegram) return;
  button.classList.remove('hidden');
  chatRender();
  chatSchedule();
}

window.addEventListener('DOMContentLoaded', chatRestore);
