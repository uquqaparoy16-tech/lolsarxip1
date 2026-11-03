'use strict';

// Вкладка «Драфт»: подбор пика и закупа. Сайт не читает игру, поэтому героев отмечает сам игрок.
// Цифры приходят из STRATZ или OpenDota, а советы против вражеского пика заданы вручную.

const DRAFT_LIMITS = { ally: 4, enemy: 5, ban: 14 }; // пятое место в команде занимает сам игрок
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
// Части больших предметов: в подсказке закупа на середину и конец игры они только мешают
const DRAFT_COMPONENTS = new Set(['hyperstone', 'mystic_staff', 'platemail', 'demon_edge', 'sacred_relic', 'reaver', 'ogre_axe', 'blade_of_alacrity', 'staff_of_wizardry', 'eagle', 'talisman_of_evasion', 'point_booster', 'vitality_booster', 'energy_booster', 'ring_of_health', 'void_stone', 'claymore', 'broadsword', 'mithril_hammer', 'javelin', 'belt_of_strength', 'boots_of_elves', 'robe', 'gloves', 'chainmail', 'quarterstaff', 'helm_of_iron_will', 'blades_of_attack', 'gauntlets', 'slippers', 'mantle', 'circlet', 'lifesteal']);
// Советы, а не статистика: какие предметы обычно берут против такого врага, отдельно для кора и поддержки
const DRAFT_ITEM_RULES = [
  { why: 'невидимость', heroes: ['Riki', 'Clinkz', 'Bounty Hunter', 'Nyx Assassin', 'Weaver'], core: ['dust'], support: ['ward_sentry', 'dust'] },
  { why: 'иллюзии', heroes: ['Phantom Lancer', 'Naga Siren', 'Terrorblade', 'Chaos Knight'], core: ['mjollnir', 'bfury'], support: [] },
  { why: 'сильное лечение', heroes: ['Necrophos', 'Alchemist', 'Huskar', 'Io', 'Omniknight'], core: ['skadi', 'spirit_vessel'], support: ['spirit_vessel'] },
  { why: 'сильная магия', heroes: ['Lion', 'Lina', 'Zeus', 'Tinker', 'Skywrath Mage', 'Leshrac', 'Pugna', 'Queen of Pain'], core: ['black_king_bar', 'pipe'], support: ['glimmer_cape', 'pipe'] },
  { why: 'контроль по одной цели', heroes: ['Doom', 'Legion Commander', 'Batrider', 'Bane', 'Beastmaster', 'Shadow Shaman', 'Lion'], core: ['sphere', 'black_king_bar'], support: ['lotus_orb', 'force_staff'] },
  { why: 'сильные атаки', heroes: ['Phantom Assassin', 'Juggernaut', 'Sven', 'Ursa', 'Troll Warlord', 'Slark', 'Lifestealer', 'Drow Ranger', 'Faceless Void'], core: ['blade_mail', 'assault'], support: ['ghost', 'force_staff'] },
  { why: 'уклонение', heroes: ['Phantom Assassin', 'Windranger'], core: ['monkey_king_bar'], support: [] },
  { why: 'быстро убегают', heroes: ['Anti-Mage', 'Puck', 'Storm Spirit', 'Ember Spirit', 'Queen of Pain', 'Slark', 'Weaver'], core: ['orchid', 'sheepstick'], support: ['rod_of_atos'] },
  { why: 'призванные существа', heroes: ['Broodmother', 'Chen', 'Enchantress', 'Lycan', "Nature's Prophet"], core: ['mjollnir', 'bfury'], support: [] },
  { why: 'сильная пассивка', heroes: ['Bristleback', 'Phantom Assassin', 'Spectre', 'Huskar'], core: ['silver_edge'], support: [] }
];
const DRAFT_FIT_MAX = 6;

const draft = {
  side: 'enemy',
  position: 5,
  query: '',
  ally: [],
  enemy: [],
  ban: [],
  myHero: null,
  itemTitles: null,
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

function draftOthers() {
  return new Set([...draft.ally, ...draft.enemy, ...draft.ban]);
}

function draftTaken() {
  const taken = draftOthers();
  if (draft.myHero) taken.add(draft.myHero);
  return taken;
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
  if (meta != null) score += (meta - 0.5) * 100;

  const mine = own.get(hero.id);
  if (mine && mine.games >= 3) {
    const edge = (mine.wins / mine.games - 0.5) * 100;
    score += Math.max(-3, Math.min(3, edge * 0.1));
    reasons.push({ edge: edge / 10, good: edge >= 0, text: `Твой винрейт: ${Math.round(edge + 50)}% за ${gamesWord(mine.games)}` });
  }

  return { id: hero.id, score, meta, reasons: reasons.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).slice(0, 3) };
}

function draftSuggestions(stats) {
  const taken = draftOthers(); // свой герой остаётся в списке и подсвечивается
  const bracket = draftBracket();
  const own = draftOwnGames();
  return stats
    .filter(hero => HEROES_DB[hero.id] && !taken.has(hero.id) && draftFitsPosition(hero.id))
    .map(hero => draftScore(hero, bracket, own))
    .sort((a, b) => b.score - a.score)
    .slice(0, DRAFT_TOP);
}

// Средний перевес твоей команды по всем парам союзник и враг
function draftTeamEdge() {
  const team = [...draft.ally, ...(draft.myHero ? [draft.myHero] : [])];
  const edges = [];
  draft.enemy.forEach(enemyId => {
    const table = draft.tables.get(enemyId);
    team.forEach(heroId => {
      const row = table && table.vs[heroId];
      if (row && row.games >= DRAFT_MIN_GAMES) edges.push((0.5 - row.wr) * 100);
    });
  });
  return edges.length > 0 ? { value: average(edges), pairs: edges.length } : null;
}

function draftItemTitle(key) {
  return (draft.itemTitles && draft.itemTitles[key]) || formatItemName(key);
}

// Предметы под вражеский пик: чем больше врагов закрывает предмет, тем он выше
function draftItemsFor(heroIds, role) {
  const names = new Set(heroIds.map(getHeroName));
  const items = new Map();

  DRAFT_ITEM_RULES.forEach(rule => {
    const found = rule.heroes.filter(name => names.has(name));
    if (found.length === 0) return;
    rule[role].forEach(key => {
      const item = items.get(key) || { key, heroes: new Set(), reasons: [] };
      found.forEach(name => item.heroes.add(name));
      item.reasons.push(`${rule.why}: ${found.join(', ')}`);
      items.set(key, item);
    });
  });

  return [...items.values()].sort((a, b) => b.heroes.size - a.heroes.size).slice(0, DRAFT_FIT_MAX);
}

function draftFitItems() {
  return draftItemsFor(draft.enemy, draft.position >= 4 ? 'support' : 'core');
}

function draftFitHtml() {
  const items = draftFitItems();
  if (items.length === 0) return '';
  const position = `позиция ${draft.position}`;
  return `
    <div class="draft-fit">
      <h4>Что брать именно под этих врагов (${position})</h4>
      ${items.map(item => `
        <div class="draft-fit-row">
          <img loading="lazy" decoding="async" src="${DRAFT_ITEM_ICON}${esc(item.key)}.png" alt="" onerror="this.remove()">
          <span><strong>${esc(draftItemTitle(item.key))}</strong><small>${esc(item.reasons.join('; '))}</small></span>
        </div>`).join('')}
      <p>Это советы по типу врага, а не статистика.</p>
    </div>`;
}

// ─── Интерфейс ──────────────────────────────────────────────────────────

function draftHeroButton(heroId, size = '') {
  return `<img loading="lazy" decoding="async" src="${getHeroIcon(heroId)}" alt="" class="${size}"><span>${esc(getHeroName(heroId))}</span>`;
}

function renderDraftSlots() {
  ['ally', 'enemy', 'ban'].forEach(side => {
    const box = document.getElementById(`draft-${side}`);
    const free = Math.max(0, (side === 'ban' ? 0 : DRAFT_LIMITS[side]) - draft[side].length);
    const me = !draft.myHero
      ? '<button type="button" class="draft-slot empty me" onclick="draftSetSide(\'me\')"><span>Твой герой</span></button>'
      : `<button type="button" class="draft-slot me" title="Убрать" aria-label="Убрать своего героя" onclick="draftClearMe()">${draftHeroButton(draft.myHero)}</button>`;
    box.innerHTML = (side === 'ally' ? me : '')
      + draft[side].map(id => `
        <button type="button" class="draft-slot" title="Убрать" aria-label="Убрать ${esc(getHeroName(id))}" onclick="draftRemove('${side}', ${id})">${draftHeroButton(id)}</button>`).join('')
      + '<span class="draft-slot empty"></span>'.repeat(free);
    const count = side === 'ally' ? `${draft.ally.length + (draft.myHero ? 1 : 0)}/5` : `${draft[side].length}/${DRAFT_LIMITS[side]}`;
    document.getElementById(`draft-${side}-count`).textContent = count;
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

  const edge = draftTeamEdge();
  box.innerHTML = `
    ${edge ? `<p class="draft-edge ${edge.value >= 0 ? 'good' : 'bad'}">Оценка драфта: ${edge.value >= 0 ? '+' : '−'}${commaNumber(Math.abs(edge.value).toFixed(1))}% в среднем по ${edge.pairs} матчапам. Это не шанс на победу.</p>` : ''}
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

// Пока герой не выбран, совет по предметам стоит под командами, а потом переезжает в закуп
function renderDraftTips() {
  const box = document.getElementById('draft-tips');
  const html = draft.myHero ? '' : draftFitHtml();
  box.classList.toggle('hidden', !html);
  box.innerHTML = html;
  document.getElementById('draft-build-fit').innerHTML = draft.myHero ? draftFitHtml() : '';
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
  await draftLoadTitles();
  if (draft.myHero !== heroId) return;
  if (!data || !itemNames) {
    box.innerHTML = '<p class="text-sm text-amber-300">Сейчас предметы недоступны. Попробуй через минуту.</p>';
    return;
  }

  box.innerHTML = draftStagesHtml(data) || '<p class="text-sm text-slate-400">Для этого героя мало данных.</p>';
}

function draftStagesHtml(data) {
  return DRAFT_STAGES.map(([key, label]) => {
    const skipConsumables = key === 'mid_game_items' || key === 'late_game_items';
    const items = Object.entries(data[key] || {})
      .map(([id, count]) => ({ key: itemNames[id], count }))
      .filter(item => item.key && !item.key.startsWith('recipe') && !(skipConsumables && (CONSUMABLE_ITEMS.has(item.key) || DRAFT_COMPONENTS.has(item.key))))
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
              ${esc(draftItemTitle(item.key))}
            </span>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderDraft(refreshPicks = true) {
  renderDraftControls();
  renderDraftSlots();
  renderDraftGrid();
  renderDraftTips();
  if (refreshPicks) renderDraftSuggestions();
}

async function draftLoadTitles() {
  if (draft.itemTitles) return;
  draft.itemTitles = await proFetchJson('/itemTitles');
  if (draft.itemTitles) renderDraftTips();
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

function draftSetMe(heroId) {
  draft.myHero = heroId;
  if (draft.side === 'me') draft.side = 'ally';
  draft.query = '';
  document.getElementById('draft-search').value = '';
  renderDraft();
  renderDraftBuild();
}

function draftAdd(heroId) {
  const side = draft.side;
  if (draftTaken().has(heroId)) return;
  if (side === 'me') {
    draftSetMe(heroId);
    return;
  }
  if (draft[side].length >= DRAFT_LIMITS[side]) {
    proToast(side === 'ally' ? 'Пятое место для тебя: нажми «Мой герой»' : `В этом списке уже ${DRAFT_LIMITS[side]} героев`);
    return;
  }
  draft[side].push(heroId);
  draft.query = '';
  document.getElementById('draft-search').value = '';
  renderDraft();
}

function draftRemove(side, heroId) {
  draft[side] = draft[side].filter(id => id !== heroId);
  renderDraft();
}

function draftClearMe() {
  draft.myHero = null;
  renderDraft();
  renderDraftBuild();
}

function draftChoose(heroId) {
  draftSetMe(heroId);
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
  draftLoadTitles();
}
