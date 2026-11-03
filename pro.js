'use strict';

// Разделы поверх основного разбора: сравнение с другими игроками, мета по рангу, тренер,
// цель с проверкой, сравнение с другом, карточка для друзей и установка на телефон.
// Все цифры приходят из OpenDota, STRATZ или матчей игрока. Если источник не ответил, раздел скрывается.

const PRO_BENCH_METRICS = [
  { key: 'gold_per_min', label: 'Золото в минуту', value: m => m.gold_per_min, digits: 0 },
  { key: 'xp_per_min', label: 'Опыт в минуту', value: m => m.xp_per_min, digits: 0 },
  { key: 'last_hits_per_min', label: 'Добивания в минуту', value: m => perMinute(m, m.last_hits), digits: 1 },
  { key: 'hero_damage_per_min', label: 'Урон по героям в минуту', value: m => perMinute(m, m.hero_damage), digits: 0 },
  { key: 'tower_damage', label: 'Урон по вышкам', value: m => m.tower_damage, digits: 0 }
];
const PRO_NEXT_STEPS = [0.5, 0.7, 0.9, 0.95, 0.99];
const PRO_BRACKETS = { 1: 'Рекрут', 2: 'Страж', 3: 'Рыцарь', 4: 'Герой', 5: 'Легенда', 6: 'Властелин', 7: 'Божество', 8: 'Титан' };
const PRO_RECENT_KEY = 'dota-recent-players';
const PRO_RECENT_MAX = 6;
const PRO_MIN_GAMES = 20;
const PRO_GOAL_TEXT = {
  deaths: g => `не больше ${g} смертей за матч`,
  gpm: g => `от ${g} золота в минуту`,
  kda: g => `KDA от ${g}`,
  towerDamage: g => `от ${g} урона по вышкам`,
  xpm: g => `от ${g} опыта в минуту`
};

const proState = {
  ai: false,
  profile: null,
  matches: [],
  summary: null,
  audit: null,
  benchHero: null,
  heroAverages: [],
  benchmarks: new Map(),
  heroStats: null,
  aiTexts: new Map(),
  replayKey: '',
  pendingVs: new URLSearchParams(location.search).get('vs'),
  pendingMatch: new URLSearchParams(location.search).get('match'),
  installPrompt: null,
  compareToken: 0,
  compareId: null,
  telegram: false,
  habitsToken: 0
};

// ─── Общее ──────────────────────────────────────────────────────────────

function perMinute(m, value) {
  return value != null && m.duration > 0 ? value / (m.duration / 60) : null;
}

function gamesWord(count) {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return `${count} игр`;
  if (ones === 1) return `${count} игра`;
  return ones >= 2 && ones <= 4 ? `${count} игры` : `${count} игр`;
}

function commaNumber(value) {
  return String(value).replace('.', ',');
}

function proToast(text) {
  const box = document.getElementById('pro-toast');
  if (!box) return;
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(proToast.timer);
  proToast.timer = setTimeout(() => box.classList.remove('show'), 2600);
}

function proRead(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function proWrite(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

async function proFetchJson(path) {
  try {
    const res = await odFetch(path);
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

function proSiteUrl(params) {
  const url = new URL(location.href.split('?')[0]);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.href;
}

async function proCopy(text, doneText) {
  try {
    await navigator.clipboard.writeText(text);
    proToast(doneText);
  } catch (e) {
    window.prompt('Скопируй ссылку:', text);
  }
}

// ─── Сравнение с другими игроками ───────────────────────────────────────

async function getBenchmarks(heroId) {
  if (!proState.benchmarks.has(heroId)) {
    const data = await proFetchJson(`/benchmarks?hero_id=${heroId}`);
    if (!data || !data.result) return null;
    proState.benchmarks.set(heroId, data.result);
  }
  return proState.benchmarks.get(heroId);
}

// Доля матчей на этом герое, где показатель ниже, чем у игрока
function percentileOf(points, value) {
  if (!Array.isArray(points) || points.length === 0 || value == null) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (value <= first.value) return first.value > 0 ? first.percentile * Math.max(0, value) / first.value : 0;
  if (value >= last.value) return last.percentile;
  for (let i = 1; i < points.length; i++) {
    const low = points[i - 1];
    const high = points[i];
    if (value <= high.value) {
      const share = high.value === low.value ? 0 : (value - low.value) / (high.value - low.value);
      return low.percentile + share * (high.percentile - low.percentile);
    }
  }
  return last.percentile;
}

function valueAtPercentile(points, percentile) {
  const exact = points.find(p => Math.abs(p.percentile - percentile) < 0.001);
  return exact ? exact.value : null;
}

function percentileLabel(percentile, points) {
  if (percentile >= points[points.length - 1].percentile) return `Лучше ${Math.round(points[points.length - 1].percentile * 100)}% матчей`;
  if (percentile < points[0].percentile) return `Ниже, чем в ${Math.round((1 - points[0].percentile) * 100)}% матчей`;
  return `Лучше ${Math.round(percentile * 100)}% матчей`;
}

function nextStepLabel(points, percentile, value, digits) {
  const step = PRO_NEXT_STEPS.find(p => p > percentile + 0.001);
  if (!step) return 'Выше этого уровня почти никто не играет.';
  const target = valueAtPercentile(points, step);
  if (target == null) return '';
  return `До верхних ${Math.round((1 - step) * 100)}%: ещё +${Math.max(0, target - value).toFixed(digits).replace('.', ',')}`;
}

function benchRows(result, source) {
  return PRO_BENCH_METRICS.map(metric => {
    const points = result[metric.key];
    const value = metric.value(source);
    if (!Array.isArray(points) || points.length === 0 || value == null) return '';
    const percentile = percentileOf(points, value);
    const width = Math.round(Math.max(2, Math.min(100, percentile * 100)));
    const tone = percentile >= 0.7 ? 'good' : percentile >= 0.4 ? 'mid' : 'bad';
    const shown = value.toFixed(metric.digits).replace('.', ',');
    return `
      <div class="pro-bar">
        <div class="pro-bar-head">
          <span>${esc(metric.label)}</span>
          <strong>${shown}</strong>
        </div>
        <div class="pro-track" role="img" aria-label="${esc(metric.label)}: ${esc(percentileLabel(percentile, points))}">
          <i class="${tone}" style="width:${width}%"></i>
        </div>
        <div class="pro-bar-foot">
          <span class="${tone}">${esc(percentileLabel(percentile, points))}</span>
          <span>${esc(nextStepLabel(points, percentile, value, metric.digits))}</span>
        </div>
      </div>`;
  }).join('');
}

function heroAverages(matches) {
  const byHero = new Map();
  matches.filter(m => !isTurbo(m)).forEach(m => {
    if (!byHero.has(m.hero_id)) byHero.set(m.hero_id, []);
    byHero.get(m.hero_id).push(m);
  });

  return [...byHero.entries()]
    .map(([heroId, games]) => {
      const mean = pick => {
        const values = games.map(pick).filter(v => v != null);
        return values.length > 0 ? average(values) : null;
      };
      return {
        heroId,
        games: games.length,
        wins: games.filter(wonMatch).length,
        kills: mean(m => m.kills),
        deaths: mean(m => m.deaths),
        assists: mean(m => m.assists),
        duration: 60,
        gold_per_min: mean(m => m.gold_per_min || null),
        xp_per_min: mean(m => m.xp_per_min || null),
        last_hits: mean(m => perMinute(m, m.last_hits)),
        hero_damage: mean(m => perMinute(m, m.hero_damage)),
        tower_damage: mean(m => m.tower_damage)
      };
    })
    .sort((a, b) => b.games - a.games);
}

async function renderBenchCard(matches) {
  const card = document.getElementById('bench-card');
  if (!card) return;
  proState.heroAverages = heroAverages(matches).slice(0, 4);
  card.classList.toggle('hidden', proState.heroAverages.length === 0);
  if (proState.heroAverages.length > 0) await proSelectBenchHero(proState.heroAverages[0].heroId);
}

async function proSelectBenchHero(heroId) {
  const hero = proState.heroAverages.find(h => h.heroId === heroId);
  const card = document.getElementById('bench-card');
  if (!hero || !card) return;
  proState.benchHero = heroId;

  document.getElementById('bench-heroes').innerHTML = proState.heroAverages.map(h => `
    <button type="button" class="pro-pill ${h.heroId === heroId ? 'active' : ''}" onclick="proSelectBenchHero(${h.heroId})">
      <img loading="lazy" decoding="async" src="${getHeroIcon(h.heroId)}" alt="">
      ${esc(getHeroName(h.heroId))} <small>${h.games}</small>
    </button>`).join('');

  const box = document.getElementById('bench-bars');
  const result = await getBenchmarks(heroId);
  if (proState.benchHero !== heroId) return;
  if (!result) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  box.innerHTML = benchRows(result, hero);
  renderProCompare(hero);
}

// Турнирные матчи дают ориентир, но там другой темп: сравнение не значит, что надо играть точно так же
async function renderProCompare(hero) {
  const box = document.getElementById('bench-pro');
  if (!box) return;
  box.innerHTML = '';
  const pro = await proFetchJson(`/pro/${hero.heroId}`);
  if (proState.benchHero !== hero.heroId) return;
  if (!pro || !(pro.games >= PRO_MIN_GAMES)) return;

  const lhMine = hero.last_hits;
  const rows = [
    ['Золото в минуту', hero.gold_per_min, pro.gpm, 0],
    ['Опыт в минуту', hero.xp_per_min, pro.xpm, 0],
    ['Добивания в минуту', lhMine, pro.lh, 1],
    ['Урон по героям в минуту', hero.hero_damage, pro.dmg, 0],
    ['Урон по вышкам', hero.tower_damage, pro.td, 0],
    ['Убийства', hero.kills, pro.kills, 1],
    ['Смерти', hero.deaths, pro.deaths, 1, true],
    ['Помощь', hero.assists, pro.assists, 1]
  ].filter(row => row[1] != null);
  const show = (value, digits) => commaNumber(value.toFixed(digits));

  box.innerHTML = `
    <h4 class="text-sm font-semibold text-white">Ты и про-игроки на ${esc(getHeroName(hero.heroId))}</h4>
    <div class="overflow-x-auto">
      <table class="stat-table">
        <thead><tr><th></th><th>Ты</th><th>Про</th></tr></thead>
        <tbody>${rows.map(([label, mine, theirs, digits, lower]) => {
          const ahead = lower ? mine <= theirs : mine >= theirs;
          return `<tr><td>${esc(label)}</td><td class="${ahead ? 'pro-win' : ''}">${show(mine, digits)}</td><td>${show(theirs, digits)}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <p class="text-xs text-slate-400">Про: ${Number(pro.games).toLocaleString()} турнирных матчей за полгода по данным OpenDota.</p>`;
}

// ─── Мета по рангу ──────────────────────────────────────────────────────

async function getHeroStats() {
  if (!proState.heroStats) {
    const list = await proFetchJson('/heroStats');
    if (Array.isArray(list) && list.length > 0) proState.heroStats = list;
  }
  return proState.heroStats;
}

function heroBracketWinrate(hero, bracket) {
  const picks = hero[`${bracket}_pick`] || 0;
  return picks > 0 ? (hero[`${bracket}_win`] || 0) / picks : null;
}

function fitsMainRole(hero, isSupportMain) {
  const role = (HEROES_DB[hero.id] && HEROES_DB[hero.id].role) || '';
  return role.includes('Support') === isSupportMain;
}

function heroChip(heroId, caption) {
  return `
    <div class="pro-hero">
      <img loading="lazy" decoding="async" src="${getHeroIcon(heroId)}" alt="">
      <span>${esc(getHeroName(heroId))}</span>
      <strong>${esc(caption)}</strong>
    </div>`;
}

async function renderMetaCard(matches, tier, audit) {
  const card = document.getElementById('meta-card');
  if (!card) return;
  card.classList.add('hidden');

  const stats = await getHeroStats();
  const bracket = tier ? Math.max(1, Math.min(8, Math.floor(tier / 10))) : null;
  if (!stats || !bracket) return;

  const pool = stats
    .filter(h => h[`${bracket}_pick`] > 0 && HEROES_DB[h.id])
    .map(h => ({ ...h, picks: h[`${bracket}_pick`], winrate: heroBracketWinrate(h, bracket) }));
  if (pool.length === 0) return;

  const averagePicks = average(pool.map(h => h.picks));
  const isSupportMain = !!audit && audit.role === 'Поддержка';
  const strong = pool
    .filter(h => h.picks >= averagePicks * 0.4 && fitsMainRole(h, isSupportMain))
    .sort((a, b) => b.winrate - a.winrate)
    .slice(0, 6);

  const mine = heroAverages(matches).filter(h => h.games >= 2).slice(0, 4).map(h => {
    const meta = pool.find(p => p.id === h.heroId);
    if (!meta) return '';
    const own = Math.round((h.wins / h.games) * 100);
    const base = Math.round(meta.winrate * 100);
    const tone = own >= base ? 'good' : 'bad';
    return `
      <div class="pro-meta-row">
        <img loading="lazy" decoding="async" src="${getHeroIcon(h.heroId)}" alt="">
        <span>${esc(getHeroName(h.heroId))}</span>
        <strong class="${tone}">${own}%</strong>
        <small>${gamesWord(h.games)}, у всех ${base}%</small>
      </div>`;
  }).join('');

  const pro = stats
    .filter(h => HEROES_DB[h.id])
    .sort((a, b) => (b.pro_pick + b.pro_ban) - (a.pro_pick + a.pro_ban))
    .slice(0, 3)
    .filter(h => h.pro_pick + h.pro_ban > 0);

  document.getElementById('meta-title').textContent = `Герои на ранге ${PRO_BRACKETS[bracket]}`;
  document.getElementById('meta-mine').innerHTML = mine || '<p class="text-sm text-slate-400">Нужно хотя бы 2 игры на одном герое.</p>';
  document.getElementById('meta-strong').innerHTML = strong.map(h => heroChip(h.id, `${(h.winrate * 100).toFixed(1).replace('.', ',')}%`)).join('');
  document.getElementById('meta-strong-title').textContent = `Сильные герои для роли «${isSupportMain ? 'Поддержка' : 'Кор'}»`;
  document.getElementById('meta-pro').innerHTML = pro.map(h => heroChip(h.id, `${h.pro_pick + h.pro_ban} пиков и банов`)).join('');
  document.getElementById('meta-pro-box').classList.toggle('hidden', pro.length === 0);
  card.classList.remove('hidden');
}

// ─── Оценки за матчи ────────────────────────────────────────────────────

function renderGradeStrip(matches) {
  const box = document.getElementById('grade-strip');
  if (!box) return;
  const rows = matches
    .map((m, index) => ({ m, index, rank: matchRank(m) }))
    .filter(row => row.rank)
    .reverse();
  box.classList.toggle('hidden', rows.length < 3);
  if (rows.length < 3) return;

  const count = tone => rows.filter(row => row.rank.tone === tone).length;
  const mean = getRankTitle(mmrToRankTier(average(rows.map(row => row.rank.mmr)))).replace(/ \(.*\)$/, '');
  box.innerHTML = `
    <div class="pro-grades">
      ${rows.map(({ m, index, rank }) => `<button type="button" class="pro-grade ${rank.tone}" title="${esc(getHeroName(m.hero_id))}: ${wonMatch(m) ? 'победа' : 'поражение'}" aria-label="Разбор матча на ${esc(getHeroName(m.hero_id))}, сыграно на ${esc(rank.title)}" onclick="inspectMatchIndex(${index})">${esc(rank.title)}</button>`).join('')}
    </div>
    <p class="text-xs text-slate-400">В среднем ты играл на ранг ${esc(mean)}. Выше своего уровня: ${count('up')}, наравне: ${count('same')}, ниже: ${count('down')}. Нажми на ранг, чтобы открыть разбор матча.</p>`;
}

// ─── Цель с проверкой ───────────────────────────────────────────────────

const proGoalKey = () => `dota-goal-${currentAccountId}`;

// Смерти и золото в матче целые, поэтому и цель целая. KDA оставляем с дробью.
function goalValue(item) {
  if (item.metricKey === 'kda') return item.goal;
  return item.metricKey === 'deaths' ? Math.floor(item.goal) : Math.ceil(item.goal);
}

function goalCandidates(audit) {
  return audit ? audit.problems.filter(p => p.metricKey && PRO_GOAL_TEXT[p.metricKey]).slice(0, 3) : [];
}

function proSetGoal(index) {
  const item = goalCandidates(proState.audit)[index];
  if (!item) return;
  proWrite(proGoalKey(), { key: item.metricKey, goal: goalValue(item), createdAt: Math.floor(Date.now() / 1000) });
  renderGoalBox();
  proToast('Цель сохранена в этом браузере');
}

function proClearGoal() {
  proWrite(proGoalKey(), null);
  renderGoalBox();
}

function renderGoalBox() {
  const box = document.getElementById('goal-box');
  if (!box) return;
  const goal = proRead(proGoalKey(), null);
  const metric = goal && AUDIT_METRICS.find(item => item.key === goal.key);

  if (!metric) {
    const candidates = goalCandidates(proState.audit);
    box.classList.toggle('hidden', candidates.length === 0);
    box.innerHTML = `
      <h3 class="font-outfit font-bold text-lg text-white">Цель на следующие игры</h3>
      <p class="text-sm text-slate-400">Выбери одну цель. После новых игр нажми «СКАН», и сайт сам проверит, получилось ли.</p>
      <div class="flex flex-wrap gap-2">
        ${candidates.map((item, i) => `<button type="button" class="pro-btn" onclick="proSetGoal(${i})">${esc(PRO_GOAL_TEXT[item.metricKey](goalValue(item)))}</button>`).join('')}
      </div>`;
    return;
  }

  const games = proState.matches.filter(m => m.start_time > goal.createdAt && !isTurbo(m) && m.gold_per_min > 0).slice().reverse();
  const passed = m => {
    const value = metric.field(m);
    return metric.lowerIsBetter ? value <= goal.goal : value >= goal.goal;
  };
  const done = games.filter(passed).length;
  const percent = games.length > 0 ? Math.round((done / games.length) * 100) : 0;

  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 class="font-outfit font-bold text-lg text-white">Цель: ${esc(PRO_GOAL_TEXT[goal.key](goal.goal))}</h3>
        <p class="text-sm text-slate-400">${games.length > 0
          ? `Выполнено в ${done} из ${games.length} игр после постановки цели (${percent}%).`
          : 'Новых игр пока нет. Сыграй матч и нажми «СКАН» ещё раз.'}</p>
      </div>
      <button type="button" class="pro-link" onclick="proClearGoal()">Сменить</button>
    </div>
    ${games.length > 0 ? `<div class="pro-dots">${games.map(m => `<span class="${passed(m) ? 'good' : 'bad'}" title="${esc(getHeroName(m.hero_id))}"></span>`).join('')}</div>` : ''}`;
}

// ─── Повторяющиеся ошибки ───────────────────────────────────────────────

const PRO_HABIT_WORKERS = 3;
const PRO_HABIT_MIN_MATCHES = 3;

function buildHabits(games) {
  const rows = games.map(getLiveMatchData).filter(Boolean).map(live => ({ live, detail: playerDetail(live.match, live.player) })).filter(row => row.detail);
  if (rows.length < PRO_HABIT_MIN_MATCHES) return null;

  const lanes = rows.map(row => laneResult(row.live.match, row.live.player)).filter(Boolean);
  const deaths = rows.flatMap(row => row.detail.deaths);
  const count = test => deaths.filter(test).length;
  const early = count(d => d.time < 600);
  const heal = count(d => d.hasHealAvailable);
  const burst = count(d => d.isBurst);
  const caught = count(d => d.isEngagedOnDeath === false);
  const gold = deaths.reduce((sum, d) => sum + (d.goldLost || 0), 0);
  const lost = lanes.filter(result => result === 'loss').length;
  const won = lanes.filter(result => result === 'win').length;
  const share = value => (deaths.length > 0 ? value / deaths.length : 0);
  const perGame = value => value / rows.length;

  const habits = [];
  if (lanes.length > 0) {
    habits.push({
      score: lanes.length > 0 ? (lost - won) / lanes.length : 0,
      bad: lost > won,
      title: `Линия: проиграно ${lost}, выиграно ${won}`,
      fact: `Итог известен в ${gamesWord(lanes.length).replace(/игры$/, 'играх').replace(/игр$/, 'играх').replace(/игра$/, 'игре')}.`,
      advice: 'Первые 10 минут важнее всего: держись у своей вышки и добивай крипов, пока не появится преимущество.'
    });
  }
  if (deaths.length > 0) {
    habits.push({
      score: perGame(early) - 1,
      bad: perGame(early) >= 1,
      title: `Смертей до 10 минуты за игру: ${commaNumber(perGame(early).toFixed(1))}`,
      fact: `${early} из ${deaths.length} смертей.`,
      advice: 'Ранняя смерть дороже всего: враг получает золото, а ты теряешь опыт на линии.'
    });
    habits.push({
      score: share(caught) - 0.25,
      bad: share(caught) >= 0.25,
      title: `Поймали вне драки: ${Math.round(share(caught) * 100)}% смертей`,
      fact: `${caught} из ${deaths.length} смертей.`,
      advice: 'Перед походом в лес смотри, кого нет на карте. Если врагов не видно, не отходи от союзников.'
    });
    habits.push({
      score: perGame(heal) - 0.5,
      bad: perGame(heal) >= 0.5,
      title: `Смертей с готовым лечением: ${heal}`,
      fact: `За ${gamesWord(rows.length)}.`,
      advice: 'Нажимай лечение раньше, когда здоровья ещё половина: после оглушения будет поздно.'
    });
    habits.push({
      score: share(burst) - 0.35,
      bad: share(burst) >= 0.35,
      title: `Убили за секунды: ${Math.round(share(burst) * 100)}% смертей`,
      fact: `${burst} из ${deaths.length} смертей.`,
      advice: 'Стой дальше от врага в начале драки и купи предмет на выживание раньше.'
    });
    habits.push({
      score: perGame(gold) / 1000 - 1,
      bad: perGame(gold) >= 1000,
      title: `Потеряно на смертях: ${Math.round(perGame(gold)).toLocaleString()} золота за игру`,
      fact: `Всего ${gold.toLocaleString()} за ${gamesWord(rows.length)}.`,
      advice: 'Перед дракой трать золото: потерять можно только то, что лежит в кармане.'
    });
  }
  const points = typeof deathPoints === 'function'
    ? rows.flatMap(row => deathPoints(row.detail.deaths, row.live.player.player_slot >= 128))
    : [];
  return { games: rows.length, points, habits: habits.sort((a, b) => b.score - a.score) };
}

function habitsHtml(result) {
  if (!result) return '<p class="text-sm text-amber-300">Подробных данных пока мало: нужно хотя бы 3 матча, разобранных STRATZ. Попробуй позже.</p>';
  return `
    <p class="text-sm text-slate-400">Разобрано матчей: ${result.games}. Сверху то, что мешает сильнее всего.</p>
    ${typeof deathMapHtml === 'function' && result.points.length > 0 ? `
      <div class="death-map-box">
        ${deathMapHtml(result.points, 'Карта смертей за все матчи')}
        <p class="text-sm text-slate-300">Карта повёрнута так, что твоя база всегда внизу слева. На чужой половине: <strong class="text-white">${enemyHalfShare(result.points)}%</strong> смертей.</p>
      </div>` : ''}
    <div class="pro-habits">
      ${result.habits.map(item => `
        <div class="pro-habit ${item.bad ? 'bad' : 'good'}">
          <strong>${esc(item.title)}</strong>
          <span>${esc(item.fact)}</span>
          ${item.bad ? `<p>${esc(item.advice)}</p>` : ''}
        </div>`).join('')}
    </div>`;
}

function renderHabits(result) {
  document.getElementById('habits-result').innerHTML = habitsHtml(result);
}

async function proLoadMatchDetails(games, workers, isActive, onStep) {
  const queue = games.slice();
  let done = 0;
  const worker = async () => {
    while (queue.length > 0 && isActive()) {
      const m = queue.shift();
      const known = REAL_MATCH_CACHE[m.match_id];
      if (!(known && known.__live)) {
        const data = await proFetchJson(`/matches/${m.match_id}`);
        if (data && Array.isArray(data.players) && data.players.length >= 10) {
          data.__live = true;
          REAL_MATCH_CACHE[m.match_id] = data;
        }
      }
      done += 1;
      if (isActive()) onStep(done);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
}

async function proLoadHabits() {
  const button = document.getElementById('habits-btn');
  const box = document.getElementById('habits-result');
  if (!button || !box) return;
  const token = ++proState.habitsToken;
  const games = pickScoredMatches(currentMatches).slice();

  button.disabled = true;
  box.innerHTML = '<p class="text-sm text-slate-400">Смотрю матчи...</p>';

  await proLoadMatchDetails(games, PRO_HABIT_WORKERS, () => token === proState.habitsToken, done => {
    box.innerHTML = `<p class="text-sm text-slate-400">Смотрю матчи: ${done} из ${games.length}...</p>`;
  });
  if (token !== proState.habitsToken) return;

  button.disabled = false;
  renderHabits(buildHabits(games));
}

// ─── Тренер ─────────────────────────────────────────────────────────────

function coachTask(match, viewer) {
  const detail = playerDetail(match, viewer);
  const deaths = viewer.deaths || 0;
  if (detail) {
    if (detail.deaths.filter(d => d.time < 600).length >= 2) return 'В следующей игре: не больше одной смерти за первые 10 минут.';
    if (detail.deaths.filter(d => d.hasHealAvailable).length >= 2) return 'В следующей игре: ни одной смерти с готовым лечением.';
    if (laneResult(match, viewer) === 'loss') return 'В следующей игре: на 10 минуте будь по золоту не хуже соперника на линии.';
  }
  if (deaths >= 7) return `В следующей игре: не больше ${Math.ceil(deaths * 0.7)} смертей.`;
  return 'В следующей игре: повтори этот результат на том же герое.';
}

function coachRuleText(match, viewer) {
  const { mistakes, good } = buildMatchMistakes(match, viewer);
  const won = (viewer.player_slot < 128) === !!match.radiant_win;
  const detail = playerDetail(match, viewer);
  const rank = detail && detail.imp != null ? matchRank({ ...viewer, imp: detail.imp }) : null;
  const grade = rank ? ` Сыграл на ранг ${rank.title}.` : '';
  const top = good[0] || mistakes[1] || `Твой счёт: ${viewer.kills || 0}/${viewer.deaths || 0}/${viewer.assists || 0}.`;
  return [
    { label: 'Главное', text: `${won ? 'Победа' : 'Поражение'}.${grade} ${top}`.trim() },
    { label: 'Ошибка', text: mistakes[0] || 'Явных ошибок в цифрах нет.' },
    { label: 'Задача', text: coachTask(match, viewer) }
  ];
}

function renderCoachRows(rows) {
  return rows.map(row => `<p><strong>${esc(row.label)}:</strong> ${esc(row.text)}</p>`).join('');
}

function renderCoachAi(text) {
  return text.split(/\n+/).filter(Boolean).map(line => `<p>${esc(line)}</p>`).join('');
}

function renderCoach(m) {
  const card = document.getElementById('rp-coach');
  const body = document.getElementById('rp-coach-body');
  if (!card || !body) return;
  const live = getLiveMatchData(m);
  card.classList.toggle('hidden', !live);
  if (!live) return;

  const key = `${m.match_id}:${live.player.hero_id}`;
  proState.replayKey = key;
  const aiText = proState.aiTexts.get(key);
  document.getElementById('rp-coach-label').textContent = aiText ? 'Текст написала нейросеть по цифрам матча' : 'Собрано автоматически из цифр матча';
  body.innerHTML = aiText ? renderCoachAi(aiText) : renderCoachRows(coachRuleText(live.match, live.player));
  document.getElementById('rp-coach-ai').classList.toggle('hidden', !proState.ai || !!aiText);
}

async function proAskCoach() {
  const m = currentActiveReplayMatch;
  const live = m ? getLiveMatchData(m) : null;
  const button = document.getElementById('rp-coach-ai');
  if (!live || !button) return;
  const key = `${m.match_id}:${live.player.hero_id}`;

  button.disabled = true;
  button.textContent = 'Думаю...';
  let text = null;
  try {
    const res = await fetch(`/api/coach/${m.match_id}/${live.player.hero_id}`);
    const data = res.ok ? await res.json() : null;
    text = data && data.text;
  } catch (e) {}
  button.disabled = false;
  button.textContent = 'Спросить нейросеть';

  if (!text) {
    proToast('Нейросеть сейчас недоступна, попробуй позже');
    return;
  }
  proState.aiTexts.set(key, text);
  if (proState.replayKey === key) renderCoach(m);
}

function proCopyMatchLink() {
  const m = currentActiveReplayMatch;
  if (!m) return;
  const params = { match: m.match_id };
  if (currentAccountId) params.id = currentAccountId;
  proCopy(proSiteUrl(params), 'Ссылка на разбор скопирована');
}

async function renderReplayBench(m) {
  const card = document.getElementById('rp-bench');
  if (!card) return;
  const matchId = m.match_id;
  if (isTurbo(m)) {
    card.classList.add('hidden');
    return;
  }
  const result = await getBenchmarks(m.hero_id);
  if (!currentActiveReplayMatch || currentActiveReplayMatch.match_id !== matchId) return;
  const live = getLiveMatchData(m);
  const source = { ...m, ...(live ? live.player : {}), duration: m.duration || (live && live.match.duration) };
  const rows = result ? benchRows(result, source) : '';
  card.classList.toggle('hidden', !rows);
  if (rows) {
    document.getElementById('rp-bench-title').textContent = `Этот матч среди других игр на ${getHeroName(m.hero_id)}`;
    document.getElementById('rp-bench-bars').innerHTML = rows;
  }
}

// ─── Сравнение с другом ─────────────────────────────────────────────────

function proSummary(matches, tier) {
  const scored = pickScoredMatches(matches).filter(m => m.gold_per_min > 0);
  if (scored.length === 0) return null;
  const skill = calculatePlayerTrueSkill(matches, tier);
  const kills = scored.reduce((sum, m) => sum + (m.kills || 0), 0);
  const assists = scored.reduce((sum, m) => sum + (m.assists || 0), 0);
  const deaths = scored.reduce((sum, m) => sum + (m.deaths || 0), 0);
  const heroes = heroAverages(scored);
  return {
    games: scored.length,
    skill,
    winrate: Math.round((scored.filter(wonMatch).length / scored.length) * 100),
    gpm: Math.round(average(scored.map(m => m.gold_per_min))),
    xpm: Math.round(average(scored.map(m => m.xp_per_min || 0))),
    kda: +((kills + assists) / Math.max(1, deaths)).toFixed(2),
    deaths: +(deaths / scored.length).toFixed(1),
    towerDamage: Math.round(average(scored.map(m => m.tower_damage || 0))),
    topHeroes: heroes.slice(0, 3).map(h => getHeroName(h.heroId))
  };
}

async function proCompare() {
  const input = document.getElementById('compare-input');
  const box = document.getElementById('compare-result');
  const button = document.getElementById('compare-btn');
  if (!input || !box || !proState.summary) return;
  const token = ++proState.compareToken;
  const fail = text => {
    box.innerHTML = `<p class="text-sm text-amber-300">${esc(text)}</p>`;
  };

  let accountId;
  try {
    accountId = await resolveAccountId(input.value);
  } catch (e) {
    return fail(e.message);
  }
  if (!accountId || typeof accountId === 'object') return fail('Нужен числовой ID из Доты или ссылка на профиль Steam.');
  if (String(accountId) === String(currentAccountId)) return fail('Это твой же профиль. Вставь ID друга.');

  button.disabled = true;
  box.innerHTML = '<p class="text-sm text-slate-400">Загружаю игрока...</p>';
  const [profile, matches] = await Promise.all([
    proFetchJson(`/players/${accountId}`),
    proFetchJson(`/players/${accountId}/recentMatches`)
  ]);
  if (token !== proState.compareToken) return;
  button.disabled = false;

  if (!profile || !profile.profile) return fail(`Игрок с ID ${accountId} не найден.`);
  const friend = Array.isArray(matches) ? proSummary(matches, profile.rank_tier || null) : null;
  if (!friend) return fail('У этого игрока нет открытых матчей, сравнить не с чем.');

  const me = proState.summary;
  const myIds = new Set(proState.matches.map(m => String(m.match_id)));
  const together = matches.filter(m => myIds.has(String(m.match_id)));
  const mineById = new Map(proState.matches.map(m => [String(m.match_id), m]));
  const sameTeam = together.filter(m => (m.player_slot < 128) === (mineById.get(String(m.match_id)).player_slot < 128));
  const sameTeamWins = sameTeam.filter(wonMatch).length;

  const rows = [
    ['Оценка', `~${me.skill.trueMMR}`, `~${friend.skill.trueMMR}`, me.skill.trueMMR - friend.skill.trueMMR],
    ['Винрейт', `${me.winrate}%`, `${friend.winrate}%`, me.winrate - friend.winrate],
    ['Золото в минуту', me.gpm, friend.gpm, me.gpm - friend.gpm],
    ['Опыт в минуту', me.xpm, friend.xpm, me.xpm - friend.xpm],
    ['KDA', commaNumber(me.kda), commaNumber(friend.kda), me.kda - friend.kda],
    ['Смерти за матч', commaNumber(me.deaths), commaNumber(friend.deaths), friend.deaths - me.deaths],
    ['Урон по вышкам', me.towerDamage.toLocaleString(), friend.towerDamage.toLocaleString(), me.towerDamage - friend.towerDamage]
  ];
  const myWins = rows.filter(r => r[3] > 0).length;
  const friendWins = rows.filter(r => r[3] < 0).length;
  const friendName = profile.profile.personaname || `ID ${accountId}`;
  const cell = (value, wins) => `<td class="${wins ? 'pro-win' : ''}">${esc(value)}</td>`;

  box.innerHTML = `
    <p class="text-sm text-slate-300">Счёт по показателям: <strong class="text-white">${myWins} : ${friendWins}</strong>${together.length > 0
      ? `. Общих матчей в последних играх: ${together.length}${sameTeam.length > 0 ? `, в одной команде ${sameTeam.length}, побед ${sameTeamWins}` : ''}.`
      : '.'}</p>
    <div class="overflow-x-auto">
      <table class="pro-table">
        <thead><tr><th></th><th>${esc(currentPlayerName)}</th><th>${esc(friendName)}</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><th>${esc(r[0])}</th>${cell(r[1], r[3] > 0)}${cell(r[2], r[3] < 0)}</tr>`).join('')}
          <tr><th>Герои</th><td>${esc(me.topHeroes.join(', '))}</td><td>${esc(friend.topHeroes.join(', '))}</td></tr>
        </tbody>
      </table>
    </div>
    <button type="button" class="pro-link" onclick="proCopyCompareLink()">Скопировать ссылку на сравнение</button>`;
  proState.compareId = accountId;
}

function proCopyCompareLink() {
  if (proState.compareId) proCopy(proSiteUrl({ id: currentAccountId, vs: proState.compareId }), 'Ссылка на сравнение скопирована');
}

// ─── Карточка для друзей ────────────────────────────────────────────────

function proFitText(ctx, text, maxWidth) {
  let shown = String(text);
  while (ctx.measureText(shown).width > maxWidth && shown.length > 1) shown = shown.slice(0, -1);
  return shown === String(text) ? shown : `${shown.trimEnd()}…`;
}

function proDrawCard() {
  const summary = proState.summary;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  const font = (size, weight = 700) => `${weight} ${size}px Outfit, Inter, system-ui, sans-serif`;

  ctx.fillStyle = '#0A0B10';
  ctx.fillRect(0, 0, 1200, 630);
  const glow = ctx.createRadialGradient(1050, 60, 40, 1050, 60, 760);
  glow.addColorStop(0, 'rgba(240, 68, 79, .42)');
  glow.addColorStop(1, 'rgba(240, 68, 79, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1200, 630);

  ctx.fillStyle = '#F0444F';
  ctx.font = font(26);
  ctx.fillText('TRUE SKILL · DOTA 2', 64, 84);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = font(66, 800);
  ctx.fillText(proFitText(ctx, currentPlayerName, 1072), 64, 172);

  ctx.font = font(44);
  ctx.fillStyle = '#F45D66';
  ctx.fillText(`${getRankTitle(summary.skill.trueTier)} · ~${summary.skill.trueMMR} ПТС`, 64, 244);

  ctx.font = font(24, 500);
  ctx.fillStyle = '#A3ACBB';
  ctx.fillText(`Оценка по ${summary.games} последним матчам`, 64, 288);

  const tiles = [
    ['Винрейт', `${summary.winrate}%`],
    ['Золото в минуту', String(summary.gpm)],
    ['KDA', String(summary.kda).replace('.', ',')],
    ['Смерти за матч', String(summary.deaths).replace('.', ',')]
  ];
  tiles.forEach(([label, value], i) => {
    const x = 64 + i * 272;
    ctx.fillStyle = 'rgba(255, 255, 255, .06)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, 332, 256, 132, 20);
      ctx.fill();
    } else {
      ctx.fillRect(x, 332, 256, 132);
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.font = font(52, 800);
    ctx.fillText(value, x + 24, 408);
    ctx.fillStyle = '#A3ACBB';
    ctx.font = font(22, 500);
    ctx.fillText(label, x + 24, 442);
  });

  ctx.fillStyle = '#CBD5E1';
  ctx.font = font(26, 600);
  if (summary.topHeroes.length > 0) ctx.fillText(proFitText(ctx, `Герои: ${summary.topHeroes.join(', ')}`, 1072), 64, 524);

  ctx.fillStyle = '#A3ACBB';
  ctx.font = font(24, 500);
  ctx.fillText(`Узнай свой уровень: ${location.host}`, 64, 578);
  return canvas;
}

async function proShareCard() {
  if (!proState.summary) return;
  const canvas = proDrawCard();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const file = new File([blob], 'moy-uroven-dota2.png', { type: 'image/png' });
  const url = proSiteUrl({ id: currentAccountId });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  proToast('Картинка сохранена');
}

function proCopyProfileLink() {
  if (currentAccountId) proCopy(proSiteUrl({ id: currentAccountId }), 'Ссылка на профиль скопирована');
}

// ─── Недавние игроки ────────────────────────────────────────────────────

function renderRecentPlayers() {
  const box = document.getElementById('recent-players');
  if (!box) return;
  const list = proRead(PRO_RECENT_KEY, []);
  const valid = Array.isArray(list) ? list.filter(item => item && /^\d{1,10}$/.test(String(item.id))) : [];
  box.classList.toggle('hidden', valid.length === 0);
  box.innerHTML = `<span class="font-mono">Недавние:</span>
    ${valid.map(item => `<button type="button" class="pro-chip" onclick="fillId('${item.id}')">${esc(String(item.name || item.id).slice(0, 18))}</button>`).join('')}
    <button type="button" class="pro-link" onclick="proClearRecent()">очистить</button>`;
}

function proClearRecent() {
  proWrite(PRO_RECENT_KEY, null);
  renderRecentPlayers();
}

function saveRecentPlayer(profile) {
  if (!currentAccountId) return;
  const info = profile.profile || {};
  const list = proRead(PRO_RECENT_KEY, []);
  const others = Array.isArray(list) ? list.filter(item => item && String(item.id) !== String(currentAccountId)) : [];
  proWrite(PRO_RECENT_KEY, [{ id: String(currentAccountId), name: info.personaname || '' }, ...others].slice(0, PRO_RECENT_MAX));
  renderRecentPlayers();
}

// ─── Точки входа из app.js ──────────────────────────────────────────────

function proOnDashboard(profile, matches, skill, audit) {
  proState.profile = profile;
  proState.matches = matches;
  proState.audit = audit;
  proState.summary = skill.noData ? null : proSummary(matches, profile.rank_tier || null);

  document.getElementById('pro-share').classList.toggle('hidden', !proState.summary);
  document.getElementById('compare-card').classList.toggle('hidden', !proState.summary);
  document.getElementById('compare-result').innerHTML = '';
  proState.habitsToken += 1;
  document.getElementById('habits-result').innerHTML = '';
  document.getElementById('habits-btn').disabled = false;
  document.getElementById('habits-card').classList.toggle('hidden', !matches.some(m => m.imp != null));

  saveRecentPlayer(profile);
  if (typeof statsResetOverview === 'function') statsResetOverview();
  if (typeof mhReset === 'function') {
    mhReset();
    if (proState.summary) mhLoad();
  }
  if (SERVER_MODE && currentAccountId && proState.summary) {
    fetch(`/api/visit/${currentAccountId}?pts=${proState.summary.skill.trueMMR}`, { method: 'POST', keepalive: true }).catch(() => {});
  }
  renderGradeStrip(matches);
  renderGoalBox();
  renderBenchCard(matches);
  renderMetaCard(matches, profile.rank_tier || skill.trueTier, audit);

  if (proState.pendingVs) {
    document.getElementById('compare-input').value = proState.pendingVs;
    proState.pendingVs = null;
    proCompare();
  }
}

// Вызывается после показа профиля: ссылка могла вести сразу на разбор матча
function proOnResults() {
  const matchId = proState.pendingMatch;
  proState.pendingMatch = null;
  if (!matchId || !/^\d{6,12}$/.test(matchId)) return;
  const index = currentMatches.findIndex(m => String(m.match_id) === matchId);
  if (index >= 0) {
    inspectMatchIndex(index);
    return;
  }
  document.getElementById('custom-match-id').value = matchId;
  switchTab('replay');
  inspectCustomMatch();
}

function proOnReplay(m) {
  renderCoach(m);
  if (typeof renderAnalyst === 'function') renderAnalyst(m);
  if (typeof renderBoard === 'function') renderBoard(m);
  if (typeof renderMatchStoryBlock === 'function') renderMatchStoryBlock(m);
  if (typeof renderReplayCard === 'function') renderReplayCard(m);
  renderReplayBench(m);
}

// ─── Запуск ─────────────────────────────────────────────────────────────

async function proCheckAi() {
  if (!SERVER_MODE) return;
  try {
    const res = await fetch('/api/health');
    const data = res.ok ? await res.json() : null;
    proState.ai = !!(data && data.sources && data.sources.ai);
    proState.telegram = !!(data && data.sources && data.sources.telegram);
    if (typeof chatStart === 'function') chatStart();
    if (proState.ai && currentActiveReplayMatch) renderCoach(currentActiveReplayMatch);
  } catch (e) {}
}

function proSetupInstall() {
  const button = document.getElementById('install-btn');
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    proState.installPrompt = event;
    if (button) button.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    if (button) button.classList.add('hidden');
  });
  if ('serviceWorker' in navigator && SERVER_MODE) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

async function proInstall() {
  const prompt = proState.installPrompt;
  if (!prompt) return;
  prompt.prompt();
  await prompt.userChoice;
  proState.installPrompt = null;
  document.getElementById('install-btn').classList.add('hidden');
}

window.addEventListener('DOMContentLoaded', () => {
  renderRecentPlayers();
  proSetupInstall();
  proCheckAi();

  // Без ссылки на игрока матч всё равно можно открыть
  if (proState.pendingMatch && !new URLSearchParams(location.search).get('id')) proOnResults();
});
