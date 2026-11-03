'use strict';

// Вкладка «Драфт»: подбор пика и закупа. Сайт не читает игру, поэтому героев отмечает сам игрок.
// Цифры приходят из STRATZ или OpenDota, а советы против вражеского пика заданы вручную.

const DRAFT_LIMITS = { ally: 4, enemy: 5, ban: 14 };
const DRAFT_TOP = 8;
const DRAFT_MIN_GAMES = 30;
const DRAFT_ITEM_ICON = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/';
const DRAFT_ROLE_WORDS = { 1: ['Carry'], 2: ['Mid'], 3: ['Offlane'], 4: ['Support', 'Roam'], 5: ['Support'] };
const DRAFT_STAGES = [
  ['start_game_items', 'Старт'],
  ['early_game_items', 'Ранняя игра'],
  ['mid_game_items', 'Середина'],
  ['late_game_items', 'Поздняя игра']
];
const DRAFT_ENEMY_TIPS = [
  { heroes: ['Riki', 'Clinkz', 'Bounty Hunter', 'Nyx Assassin', 'Weaver'], text: 'Невидимость у врага: {names}. Купите Dust и Sentry Ward.' },
  { heroes: ['Phantom Lancer', 'Naga Siren', 'Terrorblade', 'Chaos Knight'], text: 'Иллюзии у врага: {names}. Пригодится урон по площади.' },
  { heroes: ['Necrophos', 'Alchemist', 'Huskar', 'Io'], text: 'Сильное лечение у врага: {names}. Пригодится Spirit Vessel.' },
  { heroes: ['Lion', 'Lina', 'Zeus', 'Tinker', 'Skywrath Mage', 'Leshrac'], text: 'Сильная магия у врага: {names}. Подумай про Glimmer Cape или Pipe of Insight.' }
];

const draft = {
  side: 'enemy',
  position: 5,
  query: '',
  ally: [],
  enemy: [],
  ban: [],
  myHero: null,
  tables: new Map(),
  token: 0
};

// ─── Данные ─────────────────────────────────────────────────────────────

async function draftTable(heroId) {
  if (!draft.tables.has(heroId)) {
    const data = await proFetchJson(`/draft/${heroId}`);
    if (!data || !data.vs) return null;
    draft.tables.set(heroId, data);
  }
  return draft.tables.get(heroId);
}

function draftTaken() {
  return new Set([...draft.ally, ...draft.enemy, ...draft.ban]);
}

function draftFitsPosition(heroId) {
  const role = (HEROES_DB[heroId] && HEROES_DB[heroId].role) || '';
  return DRAFT_ROLE_WORDS[draft.position].some(word => role.includes(word));
}

function draftBracket() {
  const tier = currentProfileTier || (proState.summary && proState.summary.skill.trueTier);
  return tier ? Math.max(1, Math.min(8, Math.floor(tier / 10))) : null;
}

function draftMetaWinrate(hero, bracket) {
  const brackets = bracket ? [bracket] : [1, 2, 3, 4, 5, 6, 7, 8];
  const picks = brackets.reduce((sum, b) => sum + (hero[`${b}_pick`] || 0), 0);
  const wins = brackets.reduce((sum, b) => sum + (hero[`${b}_win`] || 0), 0);
  return picks > 0 ? wins / picks : null;
}

function draftOwnGames() {
  const own = new Map();
  (currentMatches || []).filter(m => !isTurbo(m)).forEach(m => {
    const row = own.get(m.hero_id) || { games: 0, wins: 0 };
    row.games += 1;
    if (wonMatch(m)) row.wins += 1;
    own.set(m.hero_id, row);
  });
  return own;
}

// Сравниваем с 50%: так разные показатели складываются в один счёт. Меньше 30 игр считаем случайностью.
function draftScore(hero, bracket, own) {
  const reasons = [];
  let score = 0;

  draft.enemy.forEach(enemyId => {
    const table = draft.tables.get(enemyId);
    const row = table && table.vs[hero.id];
    if (!row || row.games < DRAFT_MIN_GAMES) return;
    const edge = (0.5 - row.wr) * 100; // в таблице врага винрейт врага против кандидата
    score += edge;
    if (Math.abs(edge) >= 1) reasons.push({ edge, good: edge > 0, text: `Против ${getHeroName(enemyId)}: ${commaNumber((50 + edge).toFixed(1))}%` });
  });

  draft.ally.forEach(allyId => {
    const table = draft.tables.get(allyId);
    const row = table && table.with && table.with[hero.id];
    if (!row || row.games < DRAFT_MIN_GAMES) return;
    const edge = (row.wr - 0.5) * 100;
    score += edge * 0.6;
    if (Math.abs(edge) >= 1) reasons.push({ edge, good: edge > 0, text: `Вместе с ${getHeroName(allyId)}: ${commaNumber((50 + edge).toFixed(1))}%` });
  });

  const meta = draftMetaWinrate(hero, bracket);
  if (meta != null) score += (meta - 0.5) * 50;

  const mine = own.get(hero.id);
  if (mine && mine.games >= 3) {
    const edge = (mine.wins / mine.games - 0.5) * 100;
    score += Math.max(-3, Math.min(3, edge * 0.1));
    reasons.push({ edge: edge / 10, good: edge >= 0, text: `Твой винрейт: ${Math.round(edge + 50)}% за ${gamesWord(mine.games)}` });
  }

  return { id: hero.id, score, meta, reasons: reasons.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).slice(0, 3) };
}

function draftSuggestions(stats) {
  const taken = draftTaken();
  const bracket = draftBracket();
  const own = draftOwnGames();
  return stats
    .filter(hero => HEROES_DB[hero.id] && !taken.has(hero.id) && draftFitsPosition(hero.id))
    .map(hero => draftScore(hero, bracket, own))
    .sort((a, b) => b.score - a.score)
    .slice(0, DRAFT_TOP);
}

function draftEnemyTips() {
  const names = new Set(draft.enemy.map(getHeroName));
  return DRAFT_ENEMY_TIPS
    .map(tip => ({ tip, found: tip.heroes.filter(name => names.has(name)) }))
    .filter(row => row.found.length > 0)
    .map(row => row.tip.text.replace('{names}', row.found.join(', ')));
}

// ─── Интерфейс ──────────────────────────────────────────────────────────

function draftHeroButton(heroId, size = '') {
  return `<img loading="lazy" decoding="async" src="${getHeroIcon(heroId)}" alt="" class="${size}"><span>${esc(getHeroName(heroId))}</span>`;
}

function renderDraftSlots() {
  ['ally', 'enemy', 'ban'].forEach(side => {
    const box = document.getElementById(`draft-${side}`);
    const free = Math.max(0, (side === 'ban' ? 0 : DRAFT_LIMITS[side]) - draft[side].length);
    box.innerHTML = draft[side].map(id => `
      <button type="button" class="draft-slot" title="Убрать" aria-label="Убрать ${esc(getHeroName(id))}" onclick="draftRemove('${side}', ${id})">${draftHeroButton(id)}</button>`).join('')
      + '<span class="draft-slot empty"></span>'.repeat(free);
    document.getElementById(`draft-${side}-count`).textContent = `${draft[side].length}/${DRAFT_LIMITS[side]}`;
  });
}

function renderDraftControls() {
  document.querySelectorAll('[data-draft-side]').forEach(button => {
    button.classList.toggle('active', button.dataset.draftSide === draft.side);
  });
  document.querySelectorAll('[data-draft-position]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.draftPosition) === draft.position);
  });
}

function renderDraftGrid() {
  const taken = draftTaken();
  const query = draft.query.trim().toLowerCase();
  const heroes = Object.keys(HEROES_DB)
    .map(Number)
    .filter(id => !query || getHeroName(id).toLowerCase().includes(query))
    .sort((a, b) => getHeroName(a).localeCompare(getHeroName(b)));

  document.getElementById('draft-grid').innerHTML = heroes.map(id => `
    <button type="button" class="draft-hero ${taken.has(id) ? 'taken' : ''}" ${taken.has(id) ? 'disabled' : ''} onclick="draftAdd(${id})">${draftHeroButton(id)}</button>`).join('')
    || '<p class="text-sm text-slate-400">Герой не найден.</p>';
}

async function renderDraftSuggestions() {
  const box = document.getElementById('draft-result');
  const token = ++draft.token;
  const picked = [...draft.ally, ...draft.enemy];
  box.innerHTML = '<p class="text-sm text-slate-400">Считаю...</p>';

  const [stats] = await Promise.all([getHeroStats(), ...picked.map(draftTable)]);
  if (token !== draft.token) return;
  if (!stats) {
    box.innerHTML = '<p class="text-sm text-amber-300">Сейчас не получается загрузить данные. Попробуй через минуту.</p>';
    return;
  }

  const missing = picked.filter(id => !draft.tables.has(id));
  const sources = new Set(picked.map(id => draft.tables.get(id)).filter(Boolean).map(table => table.source));
  const list = draftSuggestions(stats);
  const bracket = draftBracket();
  const rank = bracket ? `на ранге ${PRO_BRACKETS[bracket]}` : 'на всех рангах';
  const empty = picked.length === 0 ? `Пока это просто сильные герои ${rank}. Отметь пики, и подсказка уточнится.` : `Учтены матчапы и связки, винрейт ${rank} и твои последние игры.`;

  box.innerHTML = `
    <p class="text-sm text-slate-400">${esc(empty)}${sources.size > 0 ? ` Источник: ${esc([...sources].join(', '))}.` : ''}</p>
    ${missing.length > 0 ? `<p class="text-sm text-amber-300">Нет данных по героям: ${esc(missing.map(getHeroName).join(', '))}.</p>` : ''}
    <div class="draft-list">
      ${list.map((row, index) => `
        <button type="button" class="draft-pick ${draft.myHero === row.id ? 'active' : ''}" onclick="draftChoose(${row.id})">
          <span class="draft-rank">${index + 1}</span>
          <img loading="lazy" decoding="async" src="${getHeroIcon(row.id)}" alt="">
          <span class="draft-pick-body">
            <strong>${esc(getHeroName(row.id))}</strong>
            <small>${row.meta != null ? `Винрейт ${rank}: ${commaNumber((row.meta * 100).toFixed(1))}%` : ''}</small>
            ${row.reasons.map(reason => `<small class="${reason.good ? 'good' : 'bad'}">${esc(reason.text)}</small>`).join('')}
          </span>
        </button>`).join('') || '<p class="text-sm text-slate-400">На эту позицию свободных героев нет.</p>'}
    </div>`;
}

function renderDraftTips() {
  const box = document.getElementById('draft-tips');
  const tips = draftEnemyTips();
  box.classList.toggle('hidden', tips.length === 0);
  box.innerHTML = tips.map(tip => `<p>${esc(tip)}</p>`).join('');
}

async function renderDraftBuild() {
  const card = document.getElementById('draft-build');
  const heroId = draft.myHero;
  card.classList.toggle('hidden', !heroId);
  if (!heroId) return;

  document.getElementById('draft-build-title').textContent = `Закуп на ${getHeroName(heroId)}`;
  const box = document.getElementById('draft-build-body');
  box.innerHTML = '<p class="text-sm text-slate-400">Загружаю предметы...</p>';

  const data = await proFetchJson(`/heroes/${heroId}/itemPopularity`);
  await loadItemNames();
  if (draft.myHero !== heroId) return;
  if (!data || !itemNames) {
    box.innerHTML = '<p class="text-sm text-amber-300">Сейчас предметы недоступны. Попробуй через минуту.</p>';
    return;
  }

  box.innerHTML = DRAFT_STAGES.map(([key, label]) => {
    const skipConsumables = key === 'mid_game_items' || key === 'late_game_items';
    const items = Object.entries(data[key] || {})
      .map(([id, count]) => ({ key: itemNames[id], count }))
      .filter(item => item.key && !item.key.startsWith('recipe') && !(skipConsumables && CONSUMABLE_ITEMS.has(item.key)))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    if (items.length === 0) return '';
    return `
      <div>
        <h4>${esc(label)}</h4>
        <div class="draft-items">
          ${items.map(item => `
            <span class="draft-item">
              <img loading="lazy" decoding="async" src="${DRAFT_ITEM_ICON}${esc(item.key)}.png" alt="" onerror="this.remove()">
              ${esc(formatItemName(item.key))}
            </span>`).join('')}
        </div>
      </div>`;
  }).join('') || '<p class="text-sm text-slate-400">Для этого героя мало данных.</p>';
}

function renderDraft(refreshPicks = true) {
  renderDraftControls();
  renderDraftSlots();
  renderDraftGrid();
  renderDraftTips();
  if (refreshPicks) renderDraftSuggestions();
}

// ─── Действия ───────────────────────────────────────────────────────────

function draftSetSide(side) {
  draft.side = side;
  renderDraft(false);
}

function draftSetPosition(position) {
  draft.position = position;
  renderDraft();
}

function draftSearch(value) {
  draft.query = value;
  renderDraftGrid();
}

function draftAdd(heroId) {
  const side = draft.side;
  if (draftTaken().has(heroId)) return;
  if (draft[side].length >= DRAFT_LIMITS[side]) {
    proToast(`В этом списке уже ${DRAFT_LIMITS[side]} героев`);
    return;
  }
  draft[side].push(heroId);
  if (draft.myHero === heroId) draft.myHero = null;
  draft.query = '';
  document.getElementById('draft-search').value = '';
  renderDraft();
  renderDraftBuild();
}

function draftRemove(side, heroId) {
  draft[side] = draft[side].filter(id => id !== heroId);
  renderDraft();
}

function draftChoose(heroId) {
  draft.myHero = heroId;
  renderDraftSuggestions();
  renderDraftBuild();
  document.getElementById('draft-build').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function draftReset() {
  draft.ally = [];
  draft.enemy = [];
  draft.ban = [];
  draft.myHero = null;
  draft.query = '';
  document.getElementById('draft-search').value = '';
  renderDraft();
  renderDraftBuild();
}

let draftReady = false;

function openDraft() {
  if (draftReady) return;
  draftReady = true;
  renderDraft();
}
