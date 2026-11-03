'use strict';

// Разбор матча в стиле киберспортивной аналитики: драфт, фарм, бои, сборки, объекты.
// Каждая строка считается из данных матча. Если цифр нет, строки нет: догадки здесь не нужны.

const ANALYST_MIN_GAMES = 30;
const ANALYST_THROW_LEAD = 5000;
const ANALYST_MAX_MISSING = 3;
const ANALYST_KEY_ITEMS = new Set([
  'blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink', 'black_king_bar', 'bfury', 'manta', 'desolator',
  'butterfly', 'radiance', 'sphere', 'assault', 'skadi', 'shivas_guard', 'heart', 'satanic', 'abyssal_blade', 'basher',
  'monkey_king_bar', 'mjollnir', 'maelstrom', 'gungir', 'hand_of_midas', 'force_staff', 'glimmer_cape', 'aether_lens',
  'ultimate_scepter', 'sheepstick', 'orchid', 'bloodthorn', 'nullifier', 'ethereal_blade', 'vanguard', 'crimson_guard',
  'pipe', 'lotus_orb', 'mekansm', 'guardian_greaves', 'vladmir', 'spirit_vessel', 'solar_crest', 'ghost', 'rod_of_atos',
  'travel_boots', 'armlet', 'echo_sabre', 'harpoon', 'silver_edge', 'invis_sword', 'diffusal_blade', 'disperser',
  'meteor_hammer', 'refresher', 'octarine_core', 'sange_and_yasha', 'kaya_and_sange', 'yasha_and_kaya', 'blade_mail',
  'wind_waker', 'phylactery', 'angels_demise', 'revenants_brooch', 'boots_of_bearing', 'wraith_pact', 'ancient_janggo'
]);

function analystSide(match, viewer) {
  const radiant = viewer.player_slot < 128;
  const allies = match.players.filter(p => (p.player_slot < 128) === radiant);
  const enemies = match.players.filter(p => (p.player_slot < 128) !== radiant);
  return { radiant, allies, enemies, won: radiant === !!match.radiant_win };
}

function analystSum(team, key) {
  return team.reduce((sum, p) => sum + (p[key] || 0), 0);
}

function analystMean(team, key) {
  return Math.round(analystSum(team, key) / Math.max(1, team.length));
}

function analystThousands(value) {
  const shown = (Math.abs(value) / 1000).toFixed(1).replace('.', ',');
  return `${shown} тыс.`;
}

function analystPercent(share) {
  return `${(share * 100).toFixed(1).replace('.', ',')}%`;
}

function analystLine(text, tone = '') {
  return { text, tone };
}

function analystBought(match, player) {
  const detail = playerDetail(match, player);
  if (!detail || !itemNames) return [];
  return detail.items
    .map(item => ({ key: itemNames[item.itemId], time: item.time }))
    .filter(item => item.key);
}

function analystKeyTimings(match, player, limit = 3) {
  const seen = new Set();
  return analystBought(match, player)
    .filter(item => ANALYST_KEY_ITEMS.has(item.key))
    .sort((a, b) => a.time - b.time)
    .filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .slice(0, limit);
}

function analystDraftEdge(side, tables) {
  const rows = [];
  side.enemies.forEach(enemy => {
    const table = tables.get(enemy.hero_id);
    if (!table) return;
    side.allies.forEach(ally => {
      const row = table.vs[ally.hero_id];
      if (row && row.games >= ANALYST_MIN_GAMES) rows.push({ ally: ally.hero_id, enemy: enemy.hero_id, edge: 0.5 - row.wr });
    });
  });
  return rows;
}

function analystDraft(match, viewer, side, tables) {
  const lines = [];
  const pairs = analystDraftEdge(side, tables);
  if (pairs.length > 0) {
    const edge = average(pairs.map(pair => pair.edge));
    const shown = `${edge >= 0 ? '+' : '−'}${Math.abs(edge * 100).toFixed(1).replace('.', ',')}%`;
    lines.push(analystLine(`Матчапы драфта: ${shown} в среднем для твоей команды.`, edge >= 0.005 ? 'good' : edge <= -0.005 ? 'bad' : ''));

    const mine = pairs.filter(pair => pair.ally === viewer.hero_id).sort((a, b) => b.edge - a.edge);
    if (mine.length > 0) {
      const best = mine[0];
      const worst = mine[mine.length - 1];
      lines.push(analystLine(`Лучший матчап: ${getHeroName(best.enemy)}, ${analystPercent(0.5 + best.edge)}. Контрпик тебя: ${getHeroName(worst.enemy)}, ${analystPercent(0.5 + worst.edge)}.`));
    }
  }

  const synergy = tables.get(viewer.hero_id);
  if (synergy && synergy.with) {
    const partners = side.allies
      .filter(ally => ally !== viewer)
      .map(ally => ({ id: ally.hero_id, row: synergy.with[ally.hero_id] }))
      .filter(item => item.row && item.row.games >= ANALYST_MIN_GAMES)
      .sort((a, b) => b.row.wr - a.row.wr);
    if (partners.length > 0) lines.push(analystLine(`Лучшая связка: с ${getHeroName(partners[0].id)}, ${analystPercent(partners[0].row.wr)}.`));
  }

  const lanes = match.details && match.details.lanes;
  if (lanes) {
    const results = Object.values(lanes).filter(Boolean);
    const won = results.filter(lane => lane !== 'TIE' && /^RADIANT/.test(lane) === side.radiant).length;
    const lost = results.filter(lane => lane !== 'TIE' && /^RADIANT/.test(lane) !== side.radiant).length;
    if (results.length > 0) lines.push(analystLine(`Лайнинг: выиграно ${won}, проиграно ${lost}, ничья ${results.length - won - lost}.`, won > lost ? 'good' : lost > won ? 'bad' : ''));
  }
  return lines;
}

function analystLeads(match, side) {
  const leads = (match.details && match.details.leads) || [];
  if (leads.length < 2) return null;
  const mine = leads.map(value => (side.radiant ? value : -value));
  const bestLead = Math.max(...mine);
  const worstLead = Math.min(...mine);
  return { bestLead, bestMinute: mine.indexOf(bestLead), worstLead, worstMinute: mine.indexOf(worstLead) };
}

function analystFarm(match, viewer, side) {
  const lines = [];
  const gpm = analystMean(side.allies, 'gold_per_min');
  const enemyGpm = analystMean(side.enemies, 'gold_per_min');
  const xpm = analystMean(side.allies, 'xp_per_min');
  const enemyXpm = analystMean(side.enemies, 'xp_per_min');
  if (gpm > 0 && enemyGpm > 0) {
    lines.push(analystLine(`GPM команды ${gpm} против ${enemyGpm}, XPM ${xpm} против ${enemyXpm}.`, gpm > enemyGpm ? 'good' : 'bad'));
  }

  const leads = analystLeads(match, side);
  if (leads) {
    if (leads.bestLead > 0) lines.push(analystLine(`Максимальный нетворс в твою пользу: +${analystThousands(leads.bestLead)} на ${leads.bestMinute} минуте.`));
    if (leads.worstLead < 0) lines.push(analystLine(`Максимальное отставание: −${analystThousands(leads.worstLead)} на ${leads.worstMinute} минуте.`));
  }

  const timings = analystKeyTimings(match, viewer);
  if (timings.length > 0) {
    lines.push(analystLine(`Твои тайминги: ${timings.map(item => `${draftItemTitle(item.key)} ${formatClock(item.time)}`).join(', ')}.`));
  }

  const topEnemy = [...side.enemies].sort((a, b) => (b.net_worth || b.gold_per_min || 0) - (a.net_worth || a.gold_per_min || 0))[0];
  const enemyTimings = topEnemy ? analystKeyTimings(match, topEnemy) : [];
  if (enemyTimings.length > 0) {
    lines.push(analystLine(`Главный кор врага ${getHeroName(topEnemy.hero_id)}: ${enemyTimings.map(item => `${draftItemTitle(item.key)} ${formatClock(item.time)}`).join(', ')}.`));
  }
  return lines;
}

function analystFights(match, viewer, side) {
  const lines = [];
  const kills = analystSum(side.allies, 'kills');
  const enemyKills = analystSum(side.enemies, 'kills');
  lines.push(analystLine(`Счёт по убийствам: ${kills} : ${enemyKills}.`, kills > enemyKills ? 'good' : kills < enemyKills ? 'bad' : ''));

  if (kills > 0) {
    const share = ((viewer.kills || 0) + (viewer.assists || 0)) / kills;
    lines.push(analystLine(`Твоё участие в убийствах: ${Math.round(share * 100)}%, KDA ${viewer.kills || 0}/${viewer.deaths || 0}/${viewer.assists || 0}.`, share >= 0.6 ? 'good' : share < 0.45 ? 'bad' : ''));
  }

  const withImp = match.players
    .map(player => ({ player, detail: playerDetail(match, player) }))
    .filter(row => row.detail && row.detail.imp != null);
  if (withImp.length > 0) {
    const best = (team, list) => list.filter(row => team.includes(row.player)).sort((a, b) => b.detail.imp - a.detail.imp)[0];
    const ally = best(side.allies, withImp);
    const enemy = best(side.enemies, withImp);
    if (ally && enemy) lines.push(analystLine(`Лучший импакт: ${getHeroName(ally.player.hero_id)} (IMP ${ally.detail.imp}) и ${getHeroName(enemy.player.hero_id)} у врага (IMP ${enemy.detail.imp}).`));
  }

  const feeder = [...side.allies].sort((a, b) => (b.deaths || 0) - (a.deaths || 0))[0];
  if (feeder && feeder.deaths >= 8) lines.push(analystLine(`Больше всего смертей в команде: ${getHeroName(feeder.hero_id)}, ${feeder.deaths}.`, 'bad'));
  return lines;
}

function analystBuilds(match, viewer, side) {
  const lines = [];
  const bought = new Set(analystBought(match, viewer).map(item => item.key));
  const haveItems = bought.size > 0;

  if (haveItems && typeof DRAFT_ITEM_RULES !== 'undefined') {
    const names = new Set(side.enemies.map(p => getHeroName(p.hero_id)));
    const position = viewer.position || 0;
    const role = position >= 4 || isSupportGame(viewer) ? 'support' : 'core';
    const missing = [];
    DRAFT_ITEM_RULES.forEach(rule => {
      const found = rule.heroes.filter(name => names.has(name));
      if (found.length === 0 || rule[role].length === 0) return;
      if (rule[role].some(key => bought.has(key))) return;
      missing.push({ key: rule[role][0], why: rule.why, found });
    });
    missing.slice(0, ANALYST_MAX_MISSING).forEach(item => {
      lines.push(analystLine(`Не куплен ${draftItemTitle(item.key)}: ${item.why} (${item.found.join(', ')}).`, 'bad'));
    });
    if (missing.length === 0) lines.push(analystLine('Сборка закрывает основные угрозы вражеского пика.', 'good'));
  }

  const count = team => team.filter(player => analystBought(match, player).some(item => item.key === 'black_king_bar')).length;
  if (haveItems) lines.push(analystLine(`BKB: ${count(side.allies)} у твоей команды и ${count(side.enemies)} у врага.`));
  return lines;
}

function analystObjectives(match, side) {
  const lines = [];
  const towers = analystSum(side.allies, 'tower_damage');
  const enemyTowers = analystSum(side.enemies, 'tower_damage');
  lines.push(analystLine(`Урон по строениям: ${towers.toLocaleString()} против ${enemyTowers.toLocaleString()}.`, towers > enemyTowers ? 'good' : 'bad'));

  const roshans = (match.objectives || []).filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL');
  if (roshans.length > 0) {
    const team = side.radiant ? 2 : 3;
    const mine = roshans.filter(o => o.team === team).length;
    lines.push(analystLine(`Рошаны: ${mine} у твоей команды, ${roshans.length - mine} у врага.`, mine > roshans.length - mine ? 'good' : mine < roshans.length - mine ? 'bad' : ''));
  }

  const wards = team => team.reduce((sum, player) => {
    const detail = playerDetail(match, player);
    return sum + (detail ? detail.wards.length : 0);
  }, 0);
  const myWards = wards(side.allies);
  const enemyWards = wards(side.enemies);
  if (myWards + enemyWards > 0) lines.push(analystLine(`Варды: ${myWards} против ${enemyWards}.`, myWards >= enemyWards ? '' : 'bad'));
  return lines;
}

function analystVerdict(match, side) {
  const leads = analystLeads(match, side);
  const winners = side.won ? side.allies : side.enemies;
  const losers = side.won ? side.enemies : side.allies;
  const strengths = [];
  const gpmGap = analystMean(winners, 'gold_per_min') - analystMean(losers, 'gold_per_min');
  const towerGap = analystSum(winners, 'tower_damage') - analystSum(losers, 'tower_damage');
  const killGap = analystSum(winners, 'kills') - analystSum(losers, 'kills');
  if (gpmGap > 0) strengths.push(`темп фарма +${gpmGap} GPM`);
  if (towerGap > 0) strengths.push(`пуш +${towerGap.toLocaleString()} урона по строениям`);
  if (killGap > 0) strengths.push(`бои +${killGap} по убийствам`);

  // Для проигравших лид считаем с их стороны: так виден упущенный матч
  const loserLead = leads ? (side.won ? -leads.worstLead : leads.bestLead) : 0;
  const loserMinute = leads ? (side.won ? leads.worstMinute : leads.bestMinute) : 0;
  let mistake = '';
  if (loserLead >= ANALYST_THROW_LEAD) {
    mistake = `вели +${analystThousands(loserLead)} на ${loserMinute} минуте, но не конвертировали преимущество.`;
  } else if (gpmGap >= 50) {
    mistake = `отставали по фарму на ${gpmGap} GPM и не нашли пика силы.`;
  } else if (towerGap > 0) {
    mistake = 'не забрали строения и отдали карту.';
  } else if (killGap > 0) {
    mistake = 'проиграли ключевые драки.';
  }

  const who = side.won ? 'твоей команды' : 'врага';
  const rival = side.won ? 'Соперники' : 'Твоя команда';
  return {
    win: strengths.length > 0 ? `Сильная сторона ${who}: ${strengths.join(', ')}.` : `Победа ${who} без явного перевеса по цифрам.`,
    lose: mistake ? `${rival}: ${mistake}` : ''
  };
}

function analyzeMatch(match, viewer, tables) {
  const side = analystSide(match, viewer);
  return {
    won: side.won,
    hasDetails: !!match.details,
    sections: [
      { title: 'Драфт и синергия', lines: analystDraft(match, viewer, side, tables) },
      { title: 'Тайминги и фарм', lines: analystFarm(match, viewer, side) },
      { title: 'Бои и импакт', lines: analystFights(match, viewer, side) },
      { title: 'Сборки', lines: analystBuilds(match, viewer, side) },
      { title: 'Объекты и карта', lines: analystObjectives(match, side) }
    ].filter(section => section.lines.length > 0),
    verdict: analystVerdict(match, side)
  };
}

function renderAnalysisHtml(result) {
  return `
    <div class="pro-analysis">
      ${result.sections.map(section => `
        <div>
          <h4>${esc(section.title)}</h4>
          <ul>${section.lines.map(line => `<li class="${line.tone}">${esc(line.text)}</li>`).join('')}</ul>
        </div>`).join('')}
    </div>
    <div class="pro-verdict">
      <p>${esc(result.verdict.win)}</p>
      ${result.verdict.lose ? `<p>${esc(result.verdict.lose)}</p>` : ''}
    </div>
    ${result.hasDetails ? '' : '<p class="text-xs text-slate-400">Подробных данных по этому матчу нет, поэтому нет таймингов, сборок и лайнинга.</p>'}`;
}

let analystToken = 0;

async function renderAnalyst(m) {
  const card = document.getElementById('rp-analyst');
  const box = document.getElementById('rp-analyst-body');
  if (!card || !box) return;
  const live = getLiveMatchData(m);
  card.classList.toggle('hidden', !live);
  if (!live) return;

  const token = ++analystToken;
  const { match, player } = live;
  const side = analystSide(match, player);
  const showBasic = () => {
    box.innerHTML = renderAnalysisHtml(analyzeMatch(match, player, draft.tables));
  };
  showBasic();

  const heroes = [...side.enemies.map(p => p.hero_id), player.hero_id];
  await Promise.all([...heroes.map(draftTable), loadItemNames(), draftLoadTitles()]);
  if (token !== analystToken) return;
  showBasic();
}
