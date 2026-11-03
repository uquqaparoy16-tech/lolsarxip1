'use strict';

// Показатели как на больших статистических сайтах: статистика за всё время, таблица матча на 10 игроков,
// график нетворса и вкладка «Герои». Всё берётся из OpenDota и STRATZ, своих оценок здесь нет.

const STATS_TOP_HEROES = 10;
const STATS_TOP_FRIENDS = 5;
const STATS_ACTIVITY_MIN = 3;
const STATS_LANES = { 1: 'Лёгкая', 2: 'Центр', 3: 'Сложная', 4: 'Лес' };
const STATS_DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const STATS_PARTS = [['Ночь', 0], ['Утро', 6], ['День', 12], ['Вечер', 18]];
const STATS_AVERAGES = [
  ['kda', 'KDA', 2], ['gold_per_min', 'GPM', 0], ['xp_per_min', 'XPM', 0], ['last_hits', 'Добивания', 0],
  ['denies', 'Денаи', 0], ['hero_damage', 'Урон по героям', 0], ['tower_damage', 'Урон по строениям', 0],
  ['hero_healing', 'Лечение', 0], ['actions_per_min', 'Действий в минуту', 0]
];
const STATS_RECORDS = {
  kills: 'Убийства', assists: 'Помощь', gold_per_min: 'GPM', xp_per_min: 'XPM',
  hero_damage: 'Урон по героям', tower_damage: 'Урон по строениям', last_hits: 'Добивания'
};
const STATS_ITEM_SLOTS = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5'];

const STATS_SMURF_WIN = 65;
const STATS_SMURF_GAP = 600;
const STATS_SMURF_GAMES = 150;
const STATS_AWARDS = [
  ['Фарм', p => p.net_worth, 'нетворс'],
  ['Убийца', p => p.kills, 'убийств'],
  ['Урон', p => p.hero_damage, 'урона'],
  ['Поддержка', p => p.assists, 'помощи'],
  ['Лечение', p => p.hero_healing, 'лечения'],
  ['Разрушитель', p => p.tower_damage, 'по строениям'],
  ['Добивания', p => p.last_hits, 'добиваний']
];

const stats = {
  overviewToken: 0,
  heroBracket: 0,
  heroSort: 'win',
  heroQuery: '',
  heroesReady: false,
  heroOpen: null,
  leadChart: null
};

function statsRate(win, games) {
  return games > 0 ? `${Math.round((win / games) * 100)}%` : '—';
}

function statsTile(label, value) {
  return `<div class="stat-tile"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
}

function statsRow(cells) {
  return `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
}

function statsHero(heroId) {
  return `<span class="stat-hero"><img loading="lazy" decoding="async" src="${getHeroIcon(heroId)}" alt="">${esc(getHeroName(heroId))}</span>`;
}

function statsDate(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleDateString('ru-RU') : '—';
}

function statsTotalsMap(totals) {
  const map = {};
  (totals || []).forEach(row => {
    if (row.n > 0) map[row.field] = row.sum / row.n;
  });
  return map;
}

// ─── Статистика за всё время ────────────────────────────────────────────

function buildOverview(data) {
  const wins = data.wl ? data.wl.win || 0 : 0;
  const losses = data.wl ? data.wl.lose || 0 : 0;
  const games = wins + losses;
  const counts = data.counts || {};
  const leaver = counts.leaver_status || {};
  const abandons = Object.entries(leaver).reduce((sum, [status, row]) => sum + (Number(status) >= 2 ? row.games : 0), 0);
  const averages = statsTotalsMap(data.totals);

  const lanes = Object.entries(counts.lane_role || {})
    .filter(([lane]) => STATS_LANES[lane])
    .map(([lane, row]) => ({ name: STATS_LANES[lane], games: row.games, win: row.win }));
  const sides = counts.is_radiant ? [
    { name: 'Силы Света', ...(counts.is_radiant[1] || { games: 0, win: 0 }) },
    { name: 'Силы Тьмы', ...(counts.is_radiant[0] || { games: 0, win: 0 }) }
  ] : [];

  return {
    games,
    wins,
    losses,
    abandons,
    averages,
    lanes,
    sides,
    heroes: (data.heroes || []).filter(h => h.games > 0).slice(0, STATS_TOP_HEROES),
    friends: (data.peers || []).filter(p => p.with_games > 0).sort((a, b) => b.with_games - a.with_games).slice(0, STATS_TOP_FRIENDS),
    records: data.records || {},
    activity: buildActivity(data.activity || [])
  };
}

// Время считаем по часам посетителя: так «вечер» совпадает с его вечером
function buildActivity(rows) {
  const days = STATS_DAYS.map(name => ({ name, games: 0, win: 0 }));
  const parts = STATS_PARTS.map(([name]) => ({ name, games: 0, win: 0 }));
  rows.forEach(row => {
    const date = new Date(row.start_time * 1000);
    const hour = date.getHours();
    const part = parts[Math.floor(hour / 6)];
    [days[date.getDay()], part].forEach(bucket => {
      bucket.games += 1;
      if (wonMatch(row)) bucket.win += 1;
    });
  });
  const ordered = [...days.slice(1), days[0]];
  const best = [...parts, ...days]
    .filter(bucket => bucket.games >= STATS_ACTIVITY_MIN)
    .sort((a, b) => b.win / b.games - a.win / a.games)[0];
  return { total: rows.length, days: ordered, parts, best };
}

// Только сигналы по открытым цифрам: это подозрение, а не доказательство
function smurfSignals(view, summary) {
  const signals = [];
  if (summary && summary.winrate >= STATS_SMURF_WIN) signals.push(`высокий винрейт в последних играх: ${summary.winrate}%`);
  if (currentProfileTier && summary && summary.skill.trueMMR - rankTierToMMR(currentProfileTier) >= STATS_SMURF_GAP) signals.push('цифры заметно выше медали');
  if (view.games > 0 && view.games < STATS_SMURF_GAMES) signals.push(`мало известных матчей: ${view.games}`);
  return signals;
}

function steamIds(accountId) {
  return [
    ['ID в Доте и код для друзей', String(accountId)],
    ['SteamID64', String(STEAM64_BASE + BigInt(accountId))],
    ['SteamID3', `[U:1:${accountId}]`]
  ];
}

function renderAccountHtml(view) {
  const signals = smurfSignals(view, proState.summary);
  const verdict = signals.length >= 3 ? 'Возможный смурф' : signals.length === 2 ? 'Есть признаки смурфа' : 'Признаков смурфа мало';
  return `
    <div class="stat-columns">
      <div>
        <h4>Проверка на смурфа: ${esc(verdict)}</h4>
        ${signals.length > 0 ? `<ul class="stat-list">${signals.map(signal => `<li>${esc(signal)}</li>`).join('')}</ul>` : '<p class="text-sm text-slate-400">Цифры не выбиваются.</p>'}
        <p class="text-xs text-slate-400 mt-1">Это подозрение по открытым цифрам, а не доказательство. OpenDota знает не все матчи, поэтому их число может быть занижено.</p>
      </div>
      <div>
        <h4>ID аккаунта</h4>
        <div class="overflow-x-auto"><table class="stat-table"><tbody>${steamIds(currentAccountId).map(([label, value]) => statsRow([esc(label), `<button type="button" class="pro-link" onclick="proCopy('${esc(value)}', 'Скопировано')">${esc(value)}</button>`])).join('')}</tbody></table></div>
      </div>
    </div>`;
}

function renderOverviewHtml(view) {
  const tiles = [
    statsTile('Матчей', view.games.toLocaleString()),
    statsTile('Побед', view.wins.toLocaleString()),
    statsTile('Поражений', view.losses.toLocaleString()),
    statsTile('Винрейт', statsRate(view.wins, view.games)),
    statsTile('Покинул игр', view.abandons.toLocaleString())
  ].join('');
  const duration = view.averages.duration ? formatMatchDuration(Math.round(view.averages.duration)) : null;
  const averages = STATS_AVERAGES
    .filter(([key]) => view.averages[key] != null)
    .map(([key, label, digits]) => statsTile(label, commaNumber(view.averages[key].toFixed(digits))))
    .concat(duration ? [statsTile('Длина матча', duration)] : [])
    .join('');

  const split = (title, rows) => (rows.length > 0 ? `
    <div>
      <h4>${esc(title)}</h4>
      <table class="stat-table"><tbody>${rows.map(row => statsRow([esc(row.name), row.games, statsRate(row.win, row.games)])).join('')}</tbody></table>
    </div>` : '');

  const heroes = view.heroes.length > 0 ? `
    <div>
      <h4>Самые играемые герои</h4>
      <div class="overflow-x-auto"><table class="stat-table">
        <thead><tr><th>Герой</th><th>Матчи</th><th>Винрейт</th><th>Последняя игра</th></tr></thead>
        <tbody>${view.heroes.map(h => statsRow([statsHero(h.hero_id), h.games, statsRate(h.win, h.games), statsDate(h.last_played)])).join('')}</tbody>
      </table></div>
    </div>` : '';

  const friends = view.friends.length > 0 ? `
    <div>
      <h4>С кем играешь чаще всего</h4>
      <div class="overflow-x-auto"><table class="stat-table">
        <thead><tr><th>Игрок</th><th>Вместе</th><th>Винрейт</th></tr></thead>
        <tbody>${view.friends.map(p => statsRow([`<button type="button" class="pro-link" onclick="fillId('${Number(p.account_id)}')">${esc(p.personaname || p.account_id)}</button>`, p.with_games, statsRate(p.with_win, p.with_games)])).join('')}</tbody>
      </table></div>
    </div>` : '';

  const records = Object.entries(STATS_RECORDS)
    .filter(([key]) => view.records[key] && view.records[key][key] != null)
    .map(([key, label]) => {
      const row = view.records[key];
      return statsRow([esc(label), Number(row[key]).toLocaleString(), statsHero(row.hero_id), `<button type="button" class="pro-link" onclick="statsOpenMatch('${Number(row.match_id)}')">Разбор</button>`]);
    }).join('');

  const activity = view.activity.total > 0 ? `
    <div>
      <h4>Активность за год</h4>
      ${view.activity.best ? `<p class="text-xs text-slate-400 mb-2">Лучший винрейт: ${esc(view.activity.best.name.toLowerCase())}, ${statsRate(view.activity.best.win, view.activity.best.games)}.</p>` : ''}
      <div class="stat-bars">
        ${[...view.activity.days, ...view.activity.parts].map(bucket => {
          const peak = Math.max(...view.activity.days.map(day => day.games), ...view.activity.parts.map(part => part.games), 1);
          return `<div class="stat-bar" title="${bucket.games} матчей"><i style="height:${Math.round((bucket.games / peak) * 100)}%"></i><span>${esc(bucket.name)}</span><small>${statsRate(bucket.win, bucket.games)}</small></div>`;
        }).join('')}
      </div>
    </div>` : '';

  return `
    <div class="stat-tiles">${tiles}</div>
    ${averages ? `<div><h4>В среднем за матч</h4><div class="stat-tiles small">${averages}</div></div>` : ''}
    <div class="stat-columns">
      ${heroes}
      ${friends}
      ${split('Линии', view.lanes)}
      ${split('Стороны', view.sides)}
      ${records ? `<div><h4>Рекорды</h4><div class="overflow-x-auto"><table class="stat-table"><tbody>${records}</tbody></table></div></div>` : ''}
      ${activity}
    </div>
    ${renderAccountHtml(view)}
    <p class="text-xs text-slate-400">Считаются только матчи, которые знает OpenDota, поэтому их может быть меньше, чем в игре.</p>`;
}

async function statsLoadOverview() {
  const button = document.getElementById('overview-btn');
  const box = document.getElementById('overview-result');
  if (!button || !box || !currentAccountId) return;
  const token = ++stats.overviewToken;
  button.disabled = true;
  box.innerHTML = '<p class="text-sm text-slate-400">Собираю статистику...</p>';

  const data = await proFetchJson(`/players/${currentAccountId}/overview`);
  if (token !== stats.overviewToken) return;
  button.disabled = false;
  if (!data || !data.wl) {
    box.innerHTML = '<p class="text-sm text-amber-300">Сейчас не получается загрузить статистику. Попробуй через минуту.</p>';
    return;
  }
  box.innerHTML = renderOverviewHtml(buildOverview(data));
  button.classList.add('hidden');
}

function statsOpenMatch(matchId) {
  document.getElementById('custom-match-id').value = matchId;
  switchTab('replay');
  inspectCustomMatch();
}

function statsResetOverview() {
  stats.overviewToken += 1;
  const button = document.getElementById('overview-btn');
  if (!button) return;
  button.disabled = false;
  button.classList.remove('hidden');
  document.getElementById('overview-result').innerHTML = '';
}

// ─── Таблица матча ──────────────────────────────────────────────────────

function statsItemIcons(player) {
  if (!itemNames) return '';
  return STATS_ITEM_SLOTS
    .map(slot => itemNames[player[slot]])
    .filter(Boolean)
    .map(key => `<img loading="lazy" decoding="async" src="${DRAFT_ITEM_ICON}${esc(key)}.png" alt="${esc(draftItemTitle(key))}" title="${esc(draftItemTitle(key))}" onerror="this.remove()">`)
    .join('');
}

function statsBoardRows(team, viewer) {
  return team.map(p => `
    <tr class="${p === viewer ? 'me' : ''}">
      <td>${statsHero(p.hero_id)}</td>
      <td>${p.level ?? '—'}</td>
      <td>${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}</td>
      <td>${formatStat(p.net_worth)}</td>
      <td>${p.last_hits ?? '—'}/${p.denies ?? '—'}</td>
      <td>${p.gold_per_min ?? '—'}/${p.xp_per_min ?? '—'}</td>
      <td>${formatStat(p.hero_damage)}</td>
      <td>${formatStat(p.hero_healing)}</td>
      <td>${formatStat(p.tower_damage)}</td>
      <td><span class="stat-items">${statsItemIcons(p)}</span></td>
    </tr>`).join('');
}

function statsAwards(match) {
  return STATS_AWARDS.map(([title, read, unit]) => {
    const best = [...match.players].sort((a, b) => (read(b) || 0) - (read(a) || 0))[0];
    return best && read(best) > 0 ? { title, unit, heroId: best.hero_id, value: read(best) } : null;
  }).filter(Boolean);
}

function statsAwardsHtml(match) {
  const awards = statsAwards(match);
  return awards.length === 0 ? '' : `
    <div class="stat-awards">
      ${awards.map(award => `<div class="stat-award"><span>${esc(award.title)}</span>${statsHero(award.heroId)}<small>${Number(award.value).toLocaleString()} ${esc(award.unit)}</small></div>`).join('')}
    </div>`;
}

function renderBoardHtml(match, viewer) {
  const radiant = match.players.filter(p => p.player_slot < 128);
  const dire = match.players.filter(p => p.player_slot >= 128);
  const head = name => `<tr><th>${esc(name)}</th><th>Ур.</th><th>K/D/A</th><th>Нетворс</th><th>LH/DN</th><th>GPM/XPM</th><th>Урон</th><th>Лечение</th><th>Строения</th><th>Предметы</th></tr>`;
  return `
    ${statsAwardsHtml(match)}
    <div class="overflow-x-auto">
      <table class="stat-table board">
        <thead>${head(`Силы Света${match.radiant_win ? ' (победа)' : ''}`)}</thead>
        <tbody>${statsBoardRows(radiant, viewer)}</tbody>
        <thead>${head(`Силы Тьмы${match.radiant_win ? '' : ' (победа)'}`)}</thead>
        <tbody>${statsBoardRows(dire, viewer)}</tbody>
      </table>
    </div>`;
}

function statsLeads(match) {
  if (match.details && Array.isArray(match.details.leads) && match.details.leads.length > 1) return match.details.leads;
  return Array.isArray(match.radiant_gold_adv) && match.radiant_gold_adv.length > 1 ? match.radiant_gold_adv : null;
}

function renderLeadChart(match) {
  const box = document.getElementById('rp-lead-box');
  const leads = statsLeads(match);
  box.classList.toggle('hidden', !leads);
  if (!leads || typeof Chart === 'undefined') return;
  if (stats.leadChart) stats.leadChart.destroy();
  stats.leadChart = new Chart(document.getElementById('rp-lead-chart'), {
    type: 'line',
    data: {
      labels: leads.map((_, minute) => minute),
      datasets: [{
        data: leads,
        borderColor: '#F0444F',
        backgroundColor: 'rgba(240, 68, 79, .12)',
        fill: 'origin',
        tension: .25,
        pointRadius: 0
      }]
    },
    options: {
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#A3ACBB', maxTicksLimit: 10 }, grid: { display: false } },
        y: { ticks: { color: '#A3ACBB' }, grid: { color: 'rgba(255, 255, 255, .06)' } }
      }
    }
  });
}

async function renderBoard(m) {
  const card = document.getElementById('rp-board');
  if (!card) return;
  const live = getLiveMatchData(m);
  card.classList.toggle('hidden', !live);
  if (!live) return;

  const paint = () => {
    document.getElementById('rp-board-body').innerHTML = renderBoardHtml(live.match, live.player);
  };
  paint();
  renderLeadChart(live.match);
  renderMatchDeathMap(m);
  await Promise.all([loadItemNames(), draftLoadTitles()]);
  if (currentActiveReplayMatch && currentActiveReplayMatch.match_id === m.match_id) paint();
}

// ─── Вкладка «Герои» ────────────────────────────────────────────────────

function statsHeroRows(list) {
  const bracket = stats.heroBracket;
  const brackets = bracket ? [bracket] : [1, 2, 3, 4, 5, 6, 7, 8];
  const totalPicks = list.reduce((sum, hero) => sum + brackets.reduce((part, b) => part + (hero[`${b}_pick`] || 0), 0), 0);
  const query = stats.heroQuery.trim().toLowerCase();

  return list
    .filter(hero => HEROES_DB[hero.id] && (!query || getHeroName(hero.id).toLowerCase().includes(query)))
    .map(hero => {
      const picks = brackets.reduce((sum, b) => sum + (hero[`${b}_pick`] || 0), 0);
      const wins = brackets.reduce((sum, b) => sum + (hero[`${b}_win`] || 0), 0);
      return {
        id: hero.id,
        picks,
        win: picks > 0 ? wins / picks : 0,
        // В матче 10 героев, поэтому доля пиков умножается на 10
        rate: totalPicks > 0 ? (picks / totalPicks) * 10 : 0,
        pro: (hero.pro_pick || 0) + (hero.pro_ban || 0),
        trend: hero.trend || 0
      };
    })
    .sort((a, b) => b[stats.heroSort] - a[stats.heroSort]);
}

async function renderHeroesTable() {
  const box = document.getElementById('heroes-table');
  const list = await getHeroStats();
  if (!list) {
    box.innerHTML = '<p class="text-sm text-amber-300">Сейчас не получается загрузить героев. Попробуй через минуту.</p>';
    return;
  }
  const rows = statsHeroRows(list);
  const percent = value => `${commaNumber((value * 100).toFixed(1))}%`;
  box.innerHTML = rows.length === 0 ? '<p class="text-sm text-slate-400">Герой не найден.</p>' : `
    <table class="stat-table clickable">
      <thead><tr>
        <th>Герой</th>
        <th><button type="button" onclick="statsSortHeroes('win')">Винрейт</button></th>
        <th><button type="button" onclick="statsSortHeroes('rate')">Пикрейт</button></th>
        <th><button type="button" onclick="statsSortHeroes('trend')">За неделю</button></th>
        <th><button type="button" onclick="statsSortHeroes('picks')">Матчи</button></th>
        <th><button type="button" onclick="statsSortHeroes('pro')">Про-сцена</button></th>
      </tr></thead>
      <tbody>${rows.map(row => `
        <tr onclick="statsOpenHero(${row.id})" class="${stats.heroOpen === row.id ? 'me' : ''}">
          <td>${statsHero(row.id)}</td>
          <td class="${row.win >= 0.52 ? 'pro-win' : ''}">${percent(row.win)}</td>
          <td>${percent(row.rate)}</td>
          <td class="${row.trend >= 0 ? 'pro-win' : ''}">${row.trend >= 0 ? '+' : '−'}${commaNumber(Math.abs(row.trend * 100).toFixed(1))}%</td>
          <td>${row.picks.toLocaleString()}</td>
          <td>${row.pro.toLocaleString()}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function statsSortHeroes(key) {
  stats.heroSort = key;
  renderHeroesTable();
}

function statsSetBracket(value) {
  stats.heroBracket = Number(value);
  renderHeroesTable();
}

function statsSearchHeroes(value) {
  stats.heroQuery = value;
  renderHeroesTable();
}

function statsMatchupList(rows, title, good) {
  if (rows.length === 0) return '';
  return `
    <div>
      <h4>${esc(title)}</h4>
      ${rows.map(row => `<div class="pro-hero"><img loading="lazy" decoding="async" src="${getHeroIcon(row.id)}" alt=""><span>${esc(getHeroName(row.id))}</span><strong class="${good ? 'good' : 'bad'}">${commaNumber((row.wr * 100).toFixed(1))}%</strong></div>`).join('')}
    </div>`;
}

async function statsOpenHero(heroId) {
  stats.heroOpen = heroId;
  renderHeroesTable();
  const card = document.getElementById('hero-detail');
  const box = document.getElementById('hero-detail-body');
  document.getElementById('hero-detail-title').textContent = getHeroName(heroId);
  card.classList.remove('hidden');
  box.innerHTML = '<p class="text-sm text-slate-400">Загружаю...</p>';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const [table, items] = await Promise.all([draftTable(heroId), proFetchJson(`/heroes/${heroId}/itemPopularity`), loadItemNames(), draftLoadTitles()]);
  if (stats.heroOpen !== heroId) return;

  const rows = data => Object.entries(data || {})
    .map(([id, row]) => ({ id: Number(id), wr: row.wr, games: row.games }))
    .filter(row => HEROES_DB[row.id] && row.games >= DRAFT_MIN_GAMES);
  const versus = rows(table && table.vs).sort((a, b) => b.wr - a.wr);
  const allies = rows(table && table.with).sort((a, b) => b.wr - a.wr);

  box.innerHTML = `
    <div class="pro-meta">
      ${statsMatchupList(versus.slice(0, 5), 'Лучше всего против', true)}
      ${statsMatchupList(versus.slice(-5).reverse(), 'Хуже всего против', false)}
      ${statsMatchupList(allies.slice(0, 5), 'Лучшие союзники', true)}
    </div>
    ${items && itemNames ? `<div class="draft-build">${draftStagesHtml(items)}</div>` : ''}
    ${table ? `<p class="text-xs text-slate-400">Матчапы: ${esc(table.source)}. Предметы: турнирные матчи OpenDota.</p>` : ''}`;
}

function openHeroes() {
  if (stats.heroesReady) return;
  stats.heroesReady = true;
  renderHeroesTable();
}
