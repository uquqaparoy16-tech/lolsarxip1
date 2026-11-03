'use strict';

// Лучшие герои игрока и советы под него. Всё считается по его собственным матчам:
// другие игроки на этом герое, его победы против поражений, предметы, враги и длина игры.

const MH_SHOWN = 5;
const MH_CANDIDATES = 8;
const MH_MIN_GAMES = 3;
const MH_PRIOR_GAMES = 5; // сглаживание: 1 победа из 1 игры не должна обгонять 7 из 10
const MH_WIN_WEIGHT = 0.6;
const MH_SUPPORT_LAST_HITS = 2.5; // меньше добиваний в минуту: герой шёл в поддержку
const MH_TIPS_MAX = 6;
const MH_MAIN_TIPS = 2;
const MH_FEW_GAMES = 5;
const MH_SPLIT_MIN = 2;
const MH_SPLIT_GAP = 0.15;
const MH_RATE_GAP = 0.3;
const MH_ITEM_MIN = 3;
const MH_MISSING_SHARE = 0.2;
const MH_MISSING_SHOWN = 3;
const MH_ENEMY_MIN = 2;
const MH_ENEMY_RATE = 0.34;
const MH_ENEMIES_SHOWN = 3;
const MH_TREND_RECENT = 4;
const MH_TREND_MIN = 8;
const MH_DEATHS_GAP = 1.5;
const MH_OWN_ITEMS = 6;
const MH_DETAIL_GAMES = 6;
const MH_DETAIL_WORKERS = 3;
const MH_LENGTHS = [
  { name: 'до 30 минут', test: m => m.duration < 1800, late: false },
  { name: '30–45 минут', test: m => m.duration >= 1800 && m.duration < 2700, late: false },
  { name: 'дольше 45 минут', test: m => m.duration >= 2700, late: true }
];
const MH_BENCH_ACTIONS = {
  gold_per_min: target => `Цель: ${target} золота в минуту. Между драками не стой без дела: забирай ближнюю волну или лагерь.`,
  xp_per_min: target => `Цель: ${target} опыта в минуту. Опыт идёт только тем, кто рядом: держись у волн и драк и реже умирай.`,
  last_hits_per_min: target => `Цель: ${target} добиваний в минуту. Потренируй первые 10 минут в демо-режиме именно на этом герое.`,
  hero_damage_per_min: target => `Цель: ${target} урона в минуту. Входи в драку вместе с командой и трать умения сразу, а не в конце.`,
  tower_damage: target => `Цель: ${target} урона по вышкам за игру. После выигранной драки сразу иди на вышку, а не в лес.`
};
const MH_SPLITS = [
  {
    name: 'смерти', read: m => m.deaths, digits: 1, lower: true,
    action: value => `Твоя норма на этом герое в победах: не больше ${Math.ceil(value)} смертей. Если их уже столько, играй осторожнее до конца матча.`
  },
  {
    name: 'золото в минуту', read: m => m.gold_per_min, digits: 0, core: true,
    action: value => `В победах у тебя ${Math.round(value)} золота в минуту. Держи этот темп: сначала фарм и предмет, потом драки.`
  },
  {
    name: 'добивания в минуту', read: m => perMinute(m, m.last_hits), digits: 1, core: true,
    action: value => `В победах у тебя ${commaNumber(value.toFixed(1))} добивания в минуту. Стоит держать этот темп с первых минут.`
  },
  {
    name: 'урон по героям в минуту', read: m => perMinute(m, m.hero_damage), digits: 0,
    action: value => `В победах у тебя ${Math.round(value)} урона в минуту. Участвуй в драках с начала, а не приходи к концу.`
  },
  {
    name: 'помощь', read: m => m.assists, digits: 1, support: true,
    action: value => `В победах у тебя ${commaNumber(value.toFixed(1))} помощи за игру. Будь рядом с командой, когда она начинает драку.`
  }
];

const myHeroes = {
  token: 0,
  detailToken: 0,
  rows: [],
  matches: [],
  open: null
};

function mhWon(m) {
  return (m.player_slot < 128) === m.radiant_win;
}

function mhMean(games, read) {
  const values = games.map(read).filter(value => value != null && Number.isFinite(value));
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function mhScoreLine(wins, games) {
  return `${wins} из ${games}`;
}

function mhNumber(value, digits) {
  return commaNumber(value.toFixed(digits));
}

function mhKda(m) {
  return (m.kills + m.assists) / Math.max(1, m.deaths);
}

// ─── Лучшие герои ───────────────────────────────────────────────────────

function mhBuildRow(heroId, games) {
  const wins = games.filter(mhWon).length;
  const lastHits = mhMean(games, m => perMinute(m, m.last_hits));
  return {
    heroId,
    games,
    count: games.length,
    wins,
    kda: mhMean(games, mhKda),
    deaths: mhMean(games, m => m.deaths),
    support: lastHits != null && lastHits < MH_SUPPORT_LAST_HITS,
    bench: [],
    score: (wins + MH_PRIOR_GAMES / 2) / (games.length + MH_PRIOR_GAMES)
  };
}

function mhGroupHeroes(matches) {
  const byHero = new Map();
  matches.forEach(m => {
    if (!HEROES_DB[m.hero_id]) return;
    if (!byHero.has(m.hero_id)) byHero.set(m.hero_id, []);
    byHero.get(m.hero_id).push(m);
  });
  const rows = [...byHero.entries()].map(([heroId, games]) => mhBuildRow(heroId, games));
  const enough = rows.filter(row => row.count >= MH_MIN_GAMES);
  return (enough.length > 0 ? enough : rows).sort((a, b) => b.score - a.score);
}

// Поддержке не нужны советы про добивания и вышки: сравниваем её только там, где она влияет на игру
function mhBenchRows(row, result) {
  const skip = row.support ? new Set(['gold_per_min', 'last_hits_per_min', 'tower_damage']) : new Set();
  return PRO_BENCH_METRICS
    .filter(metric => !skip.has(metric.key) && Array.isArray(result[metric.key]) && result[metric.key].length > 0)
    .map(metric => {
      const value = mhMean(row.games, metric.value);
      if (value == null) return null;
      return { key: metric.key, label: metric.label, digits: metric.digits, value, points: result[metric.key], percentile: percentileOf(result[metric.key], value) };
    })
    .filter(Boolean);
}

function mhApplyBench(row, result) {
  row.result = result;
  row.bench = result ? mhBenchRows(row, result) : [];
  if (row.bench.length === 0) return;
  const skill = row.bench.reduce((sum, item) => sum + item.percentile, 0) / row.bench.length;
  const steady = (skill * row.count + MH_PRIOR_GAMES / 2) / (row.count + MH_PRIOR_GAMES);
  row.score = MH_WIN_WEIGHT * row.score + (1 - MH_WIN_WEIGHT) * steady;
}

function mhStrength(row) {
  const best = row.bench.slice().sort((a, b) => b.percentile - a.percentile)[0];
  return best ? `${best.label}: ${percentileLabel(best.percentile, best.points).toLowerCase()}` : '';
}

async function mhLoad() {
  const card = document.getElementById('myheroes-card');
  const box = document.getElementById('myheroes-list');
  if (!card || !box || !currentAccountId) return;
  const token = ++myHeroes.token;
  myHeroes.rows = [];
  myHeroes.open = null;
  document.getElementById('myheroes-detail').innerHTML = '';
  card.classList.remove('hidden');
  box.innerHTML = '<p class="text-sm text-slate-400">Считаю лучших героев...</p>';

  const matches = await proFetchJson(`/players/${currentAccountId}/heroMatches`);
  if (token !== myHeroes.token) return;
  if (!Array.isArray(matches) || matches.length === 0) {
    card.classList.add('hidden');
    return;
  }

  const all = mhGroupHeroes(matches);
  const usual = all.slice().sort((a, b) => b.count - a.count)[0];
  const rows = all.slice(0, MH_CANDIDATES);
  if (!rows.includes(usual)) rows.push(usual);
  const benches = await Promise.all(rows.map(row => getBenchmarks(row.heroId)));
  if (token !== myHeroes.token) return;
  rows.forEach((row, index) => mhApplyBench(row, benches[index]));

  myHeroes.matches = matches;
  myHeroes.rows = rows.sort((a, b) => b.score - a.score).slice(0, MH_SHOWN);
  if (!myHeroes.rows.includes(usual)) myHeroes.rows.push({ ...usual, usual: true });
  mhRenderList();
  mhOpen(myHeroes.rows[0].heroId, false);
}

function mhRenderList() {
  document.getElementById('myheroes-list').innerHTML = myHeroes.rows.map((row, index) => `
    <button type="button" class="mh-hero ${row.heroId === myHeroes.open ? 'active' : ''}" onclick="mhOpen(${row.heroId})">
      <img loading="lazy" decoding="async" src="${getHeroIcon(row.heroId)}" alt="">
      <span class="mh-name"><small>${row.usual ? 'чаще всего' : `${index + 1}.`}</small>${esc(getHeroName(row.heroId))}</span>
      <span class="mh-line">Победы ${mhScoreLine(row.wins, row.count)}, KDA ${mhNumber(row.kda, 1)}</span>
    </button>`).join('');
}

// ─── Советы под игрока ──────────────────────────────────────────────────

function mhTipSplit(row) {
  const wins = row.games.filter(mhWon);
  const losses = row.games.filter(m => !mhWon(m));
  if (wins.length < MH_SPLIT_MIN || losses.length < MH_SPLIT_MIN) return null;

  const best = MH_SPLITS
    .filter(split => (!split.core || !row.support) && (!split.support || row.support))
    .map(split => {
      const won = mhMean(wins, split.read);
      const lost = mhMean(losses, split.read);
      if (won == null || lost == null || Math.max(won, lost) === 0) return null;
      const better = split.lower ? won < lost : won > lost;
      return better ? { split, won, lost, gap: Math.abs(won - lost) / Math.max(won, lost) } : null;
    })
    .filter(item => item && item.gap >= MH_SPLIT_GAP)
    .sort((a, b) => b.gap - a.gap)[0];
  if (!best) return null;

  return {
    weight: 0.5 + best.gap,
    title: `Главное отличие твоих побед от поражений: ${best.split.name}`,
    fact: `В победах ${mhNumber(best.won, best.split.digits)}, в поражениях ${mhNumber(best.lost, best.split.digits)}.`,
    action: best.split.action(best.won)
  };
}

function mhTipBench(row) {
  const worst = row.bench.slice().sort((a, b) => a.percentile - b.percentile)[0];
  if (!worst) return null;
  const step = PRO_NEXT_STEPS.find(value => value > worst.percentile + 0.001);
  const target = valueAtPercentile(worst.points, step);
  const shown = target == null ? null : mhNumber(target, worst.digits);
  return {
    weight: 1 - worst.percentile,
    title: `Слабее всего на ${getHeroName(row.heroId)}: ${worst.label.toLowerCase()}`,
    fact: `У тебя ${mhNumber(worst.value, worst.digits)}. ${percentileLabel(worst.percentile, worst.points)} на этом герое.`,
    action: shown ? MH_BENCH_ACTIONS[worst.key](shown) : ''
  };
}

function mhTipDeaths(row, matches) {
  const others = matches.filter(m => m.hero_id !== row.heroId);
  const usual = mhMean(others, m => m.deaths);
  if (usual == null || row.deaths - usual < MH_DEATHS_GAP) return null;
  return {
    weight: 0.5 + (row.deaths - usual) / 10,
    title: `На этом герое ты умираешь чаще обычного`,
    fact: `${mhNumber(row.deaths, 1)} смертей за игру, на других героях ${mhNumber(usual, 1)}.`,
    action: 'Ты играешь на нём рискованнее, чем обычно. Перед каждым заходом проверяй, кого из врагов нет на карте.'
  };
}

function mhTipLength(row) {
  const buckets = MH_LENGTHS
    .map(bucket => {
      const games = row.games.filter(bucket.test);
      return { ...bucket, games: games.length, wins: games.filter(mhWon).length };
    })
    .filter(bucket => bucket.games >= MH_ITEM_MIN);
  const rate = bucket => bucket.wins / bucket.games;
  const worst = buckets.slice().sort((a, b) => rate(a) - rate(b))[0];
  const best = buckets.slice().sort((a, b) => rate(b) - rate(a))[0];
  if (!worst || !best || worst === best || rate(best) - rate(worst) < MH_RATE_GAP) return null;
  return {
    weight: 0.45 + (rate(best) - rate(worst)) / 2,
    title: `Лучше всего тебе идут игры ${best.name}`,
    fact: `Победы: ${best.name} ${mhScoreLine(best.wins, best.games)}, ${worst.name} ${mhScoreLine(worst.wins, worst.games)}.`,
    action: worst.late
      ? 'Поздние игры уходят от тебя. Если есть перевес, не затягивай: сразу иди на вышки и Рошана вместе с командой.'
      : 'Игра решается раньше, чем ты входишь в силу. Первые 15 минут играй осторожнее и не давай врагу разогнаться.'
  };
}

function mhItemKeys(m) {
  if (!itemNames) return [];
  const keys = STATS_ITEM_SLOTS
    .map(slot => itemNames[m[slot]])
    .filter(key => key && !key.startsWith('recipe') && !CONSUMABLE_ITEMS.has(key) && !DRAFT_COMPONENTS.has(key));
  return [...new Set(keys)];
}

function mhItemCounts(row) {
  const counts = new Map();
  row.games.forEach(m => mhItemKeys(m).forEach(key => {
    const entry = counts.get(key) || { key, games: 0, wins: 0 };
    entry.games += 1;
    if (mhWon(m)) entry.wins += 1;
    counts.set(key, entry);
  }));
  return counts;
}

function mhTipItem(row, counts) {
  const best = [...counts.values()]
    .map(item => {
      const otherGames = row.count - item.games;
      const otherWins = row.wins - item.wins;
      if (item.games < MH_ITEM_MIN || otherGames < MH_SPLIT_MIN) return null;
      return { ...item, otherGames, otherWins, gap: item.wins / item.games - otherWins / otherGames };
    })
    .filter(item => item && Math.abs(item.gap) >= MH_RATE_GAP)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
  if (!best) return null;

  const name = draftItemTitle(best.key);
  const fact = `С ним победы ${mhScoreLine(best.wins, best.games)}, без него ${mhScoreLine(best.otherWins, best.otherGames)}.`;
  return best.gap > 0
    ? { weight: 0.4 + best.gap / 2, title: `Твой лучший предмет на этом герое: ${name}`, fact, action: 'Старайся собирать его раньше других предметов.', item: best.key, good: true }
    : { weight: 0.4 + Math.abs(best.gap) / 2, title: `С предметом ${name} ты играешь хуже`, fact, action: 'Попробуй заменить его: ниже есть твоя сборка и обычная сборка на этом герое.', item: best.key };
}

function mhTipMissing(row, counts, popular) {
  if (!popular || !itemNames) return null;
  if (row.support && HEROES_DB[row.heroId].role !== 'Support') return null;

  const totals = new Map();
  ['mid_game_items', 'late_game_items'].forEach(stage => {
    Object.entries(popular[stage] || {}).forEach(([id, count]) => {
      const key = itemNames[id];
      if (!key || key.startsWith('recipe') || CONSUMABLE_ITEMS.has(key) || DRAFT_COMPONENTS.has(key)) return;
      totals.set(key, (totals.get(key) || 0) + count);
    });
  });
  const missing = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MH_CANDIDATES)
    .map(([key]) => ({ key, games: counts.has(key) ? counts.get(key).games : 0 }))
    .filter(item => item.games / row.count < MH_MISSING_SHARE)
    .slice(0, MH_MISSING_SHOWN);
  if (missing.length === 0) return null;

  return {
    weight: 0.4 + missing.length / 10,
    title: `Редко собираешь то, что обычно берут на этом герое`,
    fact: missing.map(item => `${draftItemTitle(item.key)}: ${mhScoreLine(item.games, row.count)} игр`).join(', ') + '.',
    action: 'Это частые предметы в турнирных матчах. Сравни их со своей сборкой и попробуй хотя бы один.',
    items: missing.map(item => item.key)
  };
}

function mhTipEnemies(row, versus) {
  const rate = enemy => enemy.win / enemy.games;
  const worst = (versus || [])
    .filter(enemy => HEROES_DB[enemy.hero_id] && enemy.games >= MH_ENEMY_MIN && rate(enemy) <= MH_ENEMY_RATE)
    .sort((a, b) => (b.games - b.win) - (a.games - a.win) || rate(a) - rate(b))
    .slice(0, MH_ENEMIES_SHOWN);
  if (worst.length === 0) return null;

  const items = draftItemsFor(worst.map(enemy => enemy.hero_id), row.support ? 'support' : 'core').slice(0, MH_MISSING_SHOWN);
  return {
    weight: 0.45 + worst.length / 10,
    title: `Тяжелее всего тебе против: ${worst.map(enemy => getHeroName(enemy.hero_id)).join(', ')}`,
    fact: `Победы: ${worst.map(enemy => `${getHeroName(enemy.hero_id)} ${mhScoreLine(enemy.win, enemy.games)}`).join(', ')}.`,
    action: items.length > 0
      ? `Против них попробуй: ${items.map(item => `${draftItemTitle(item.key)} (${[...item.reasons].join('; ')})`).join(', ')}.`
      : 'Если враг взял такого героя раньше тебя, лучше выбрать другого.',
    items: items.map(item => item.key)
  };
}

function mhTipParty(row) {
  const solo = row.games.filter(m => m.party_size === 1);
  const party = row.games.filter(m => m.party_size > 1);
  if (solo.length < MH_ITEM_MIN || party.length < MH_ITEM_MIN) return null;
  const soloWins = solo.filter(mhWon).length;
  const partyWins = party.filter(mhWon).length;
  const gap = partyWins / party.length - soloWins / solo.length;
  if (Math.abs(gap) < MH_RATE_GAP) return null;
  return {
    weight: 0.35 + Math.abs(gap) / 2,
    title: gap > 0 ? 'С друзьями на этом герое ты играешь лучше' : 'Один на этом герое ты играешь лучше',
    fact: `Победы одному ${mhScoreLine(soloWins, solo.length)}, в группе ${mhScoreLine(partyWins, party.length)}.`,
    action: gap > 0 ? 'Этому герою нужна команда рядом. В одиночных играх выбирай его, только если союзники готовы играть вместе.' : 'В группе тебе может быть тесно на этой роли. Договаривайтесь заранее, кто берёт фарм.',
    good: true
  };
}

function mhTipTrend(row) {
  if (row.count < MH_TREND_MIN) return null;
  const recent = row.games.slice(0, MH_TREND_RECENT);
  const earlier = row.games.slice(MH_TREND_RECENT);
  const recentWins = recent.filter(mhWon).length;
  const earlierWins = earlier.filter(mhWon).length;
  const gap = recentWins / recent.length - earlierWins / earlier.length;
  if (Math.abs(gap) < MH_RATE_GAP) return null;
  const fact = `Победы в последних ${recent.length} играх: ${recentWins}. Раньше ${mhScoreLine(earlierWins, earlier.length)}.`;
  return gap > 0
    ? { weight: 0.3, title: 'Ты стал играть на этом герое лучше', fact, action: 'Продолжай в том же духе: что бы ты ни изменил, это работает.', good: true }
    : { weight: 0.7, title: 'В последних играх на этом герое стало хуже', fact, action: 'Открой разбор последнего поражения ниже и посмотри, что изменилось.' };
}

function buildHeroGuide(row, data) {
  const counts = mhItemCounts(row);
  return [
    mhTipSplit(row),
    mhTipBench(row),
    mhTipDeaths(row, data.matches),
    mhTipLength(row),
    mhTipItem(row, counts),
    mhTipMissing(row, counts, data.popular),
    mhTipEnemies(row, data.versus),
    mhTipParty(row),
    mhTipTrend(row)
  ].filter(Boolean).sort((a, b) => b.weight - a.weight).slice(0, MH_TIPS_MAX);
}

// ─── Показ ──────────────────────────────────────────────────────────────

function mhTipHtml(tip) {
  const icons = (tip.items || (tip.item ? [tip.item] : []))
    .map(key => `<img loading="lazy" decoding="async" src="${DRAFT_ITEM_ICON}${esc(key)}.png" alt="" onerror="this.remove()">`).join('');
  return `
    <div class="pro-habit ${tip.good ? 'good' : 'bad'}">
      <strong>${esc(tip.title)}</strong>
      <span>${esc(tip.fact)}</span>
      ${icons ? `<div class="mh-items">${icons}</div>` : ''}
      ${tip.action ? `<p>${esc(tip.action)}</p>` : ''}
    </div>`;
}

function mhMatchButton(label, m) {
  if (!m) return '';
  const score = `${m.kills}/${m.deaths}/${m.assists}, ${formatMatchDuration(m.duration)}`;
  return `<button type="button" class="pro-btn" onclick="statsOpenMatch('${Number(m.match_id)}')">${esc(label)}: ${esc(score)}</button>`;
}

function mhBenchSource(row) {
  return {
    duration: 60,
    gold_per_min: mhMean(row.games, m => m.gold_per_min),
    xp_per_min: mhMean(row.games, m => m.xp_per_min),
    last_hits: mhMean(row.games, m => perMinute(m, m.last_hits)),
    hero_damage: mhMean(row.games, m => perMinute(m, m.hero_damage)),
    tower_damage: mhMean(row.games, m => m.tower_damage)
  };
}

function mhOwnItemsHtml(row) {
  const items = [...mhItemCounts(row).values()].sort((a, b) => b.games - a.games).slice(0, MH_OWN_ITEMS);
  if (items.length === 0) return '';
  return `
    <div>
      <h4>Что собираешь ты</h4>
      <div class="draft-items">
        ${items.map(item => `
          <span class="draft-item">
            <img loading="lazy" decoding="async" src="${DRAFT_ITEM_ICON}${esc(item.key)}.png" alt="" onerror="this.remove()">
            ${esc(draftItemTitle(item.key))} <small>${mhScoreLine(item.games, row.count)}</small>
          </span>`).join('')}
      </div>
    </div>`;
}

function mhGuideHtml(row, tips, popular) {
  const byKda = row.games.slice().sort((a, b) => mhKda(b) - mhKda(a));
  const best = byKda.find(mhWon);
  const worst = byKda.slice().reverse().find(m => !mhWon(m));
  const strength = mhStrength(row);
  const main = tips.slice(0, MH_MAIN_TIPS);
  const rest = tips.slice(MH_MAIN_TIPS);
  return `
    <h4 class="text-base font-semibold text-white">Главное на ${esc(getHeroName(row.heroId))}</h4>
    ${row.count < MH_FEW_GAMES ? `<p class="text-xs text-amber-300">Игр на этом герое пока мало, выводы примерные.</p>` : ''}
    ${main.length > 0
      ? `<div class="pro-habits">${main.map(mhTipHtml).join('')}</div>`
      : '<p class="text-sm text-slate-400">Явных слабых мест не видно.</p>'}
    <details class="mh-more">
      <summary>Подробнее</summary>
      <div class="space-y-4">
        ${strength ? `<p class="text-sm text-slate-300">Сильная сторона. ${esc(strength)}.</p>` : ''}
        ${rest.length > 0 ? `<div class="pro-habits">${rest.map(mhTipHtml).join('')}</div>` : ''}
        ${row.result ? `<div class="space-y-3"><h4 class="text-sm font-semibold text-white">Сколько не хватает до следующего уровня</h4>${benchRows(row.result, mhBenchSource(row))}</div>` : ''}
        <div class="draft-build">
          ${mhOwnItemsHtml(row)}
          ${popular && itemNames ? draftStagesHtml(popular) : ''}
        </div>
        <div class="flex flex-wrap gap-2">
          ${mhMatchButton('Лучшая игра', best)}
          ${mhMatchButton('Худшая игра', worst)}
          <button id="mh-errors-btn" type="button" class="pro-btn" onclick="mhLoadErrors(${row.heroId})">Найти ошибки в последних матчах</button>
        </div>
        <div id="mh-errors" class="space-y-3" aria-live="polite"></div>
        <p class="text-xs text-slate-400">Советы посчитаны по твоим матчам. Турбо и покинутые игры не считаются. Победы и показатели связаны, но одно не всегда причина другого.</p>
      </div>
    </details>`;
}

async function mhOpen(heroId, scroll = true) {
  const row = myHeroes.rows.find(item => item.heroId === heroId);
  const box = document.getElementById('myheroes-detail');
  if (!row || !box) return;
  myHeroes.open = heroId;
  myHeroes.detailToken += 1;
  mhRenderList();
  box.innerHTML = '<p class="text-sm text-slate-400">Собираю советы...</p>';
  if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const [popular, versus] = await Promise.all([
    proFetchJson(`/heroes/${heroId}/itemPopularity`),
    proFetchJson(`/players/${currentAccountId}/heroVs/${heroId}`),
    loadItemNames(),
    draftLoadTitles()
  ]);
  if (myHeroes.open !== heroId) return;
  box.innerHTML = mhGuideHtml(row, buildHeroGuide(row, { matches: myHeroes.matches, popular, versus }), popular);
}

async function mhLoadErrors(heroId) {
  const row = myHeroes.rows.find(item => item.heroId === heroId);
  const box = document.getElementById('mh-errors');
  const button = document.getElementById('mh-errors-btn');
  if (!row || !box) return;
  const token = ++myHeroes.detailToken;
  const games = row.games.slice(0, MH_DETAIL_GAMES);
  button.disabled = true;
  box.innerHTML = '<p class="text-sm text-slate-400">Смотрю матчи на этом герое...</p>';

  await proLoadMatchDetails(games, MH_DETAIL_WORKERS, () => token === myHeroes.detailToken, done => {
    box.innerHTML = `<p class="text-sm text-slate-400">Смотрю матчи: ${done} из ${games.length}...</p>`;
  });
  if (token !== myHeroes.detailToken) return;
  button.disabled = false;
  box.innerHTML = habitsHtml(buildHabits(games));
}

function mhReset() {
  myHeroes.token += 1;
  myHeroes.detailToken += 1;
  myHeroes.rows = [];
  myHeroes.open = null;
  const card = document.getElementById('myheroes-card');
  if (card) card.classList.add('hidden');
}
