'use strict';

// Досье каждого из 10 игроков и рассказ, почему матч проигран или выигран.
// Только то, что есть в данных матча: смерти, убийства, покупки, нетворс по минутам.

const CASE_WINDOW_MINUTES = 5;
const CASE_TIMELINE_ITEMS = 6;
const CASE_MAX_REASONS = 6;

function caseMinutes(seconds) {
  return Math.max(1, (seconds || 0) / 60);
}

// Самые дорогие или лучшие пять минут для команды
function caseSwing(match, side) {
  const leads = (match.details && match.details.leads) || [];
  if (leads.length <= CASE_WINDOW_MINUTES) return null;
  const mine = leads.map(value => (side.radiant ? value : -value));
  const direction = side.won ? 1 : -1;
  let best = null;
  for (let to = CASE_WINDOW_MINUTES; to < mine.length; to++) {
    const change = mine[to] - mine[to - CASE_WINDOW_MINUTES];
    if (!best || change * direction > best.change * direction) best = { from: to - CASE_WINDOW_MINUTES, to, change };
  }
  return best && best.change * direction > 0 ? best : null;
}

function caseDeathsBetween(match, team, fromSeconds, toSeconds) {
  return team
    .map(player => {
      const detail = playerDetail(match, player);
      const count = detail ? detail.deaths.filter(d => d.time >= fromSeconds && d.time < toSeconds).length : 0;
      return { hero: player.hero_id, count };
    })
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

function caseDeathList(rows) {
  return rows.map(row => `${getHeroName(row.hero)} ${row.count}`).join(', ');
}

function caseLaneRows(match, side) {
  return side.allies
    .filter(player => player.position)
    .map(player => {
      const rival = side.enemies.find(p => p.position === player.position);
      const mine = playerDetail(match, player);
      const theirs = rival ? playerDetail(match, rival) : null;
      if (!mine || !theirs || mine.networth.length <= 10 || theirs.networth.length <= 10) return null;
      return { player, rival, gap: mine.networth[10] - theirs.networth[10] };
    })
    .filter(Boolean)
    .sort((a, b) => a.gap - b.gap);
}

function buildMatchStory(match, viewer) {
  const side = analystSide(match, viewer);
  const rows = [];

  const lanes = caseLaneRows(match, side);
  if (lanes.length > 0) {
    const worst = lanes[0];
    const best = lanes[lanes.length - 1];
    if (worst.gap < 0) {
      rows.push({ time: 600, label: '10:00', tone: 'bad', text: `Хуже всего линия: ${getHeroName(worst.player.hero_id)} отстаёт от ${getHeroName(worst.rival.hero_id)} на ${Math.abs(worst.gap).toLocaleString()} нетворса.` });
    }
    if (best.gap > 0) {
      rows.push({ time: 600, label: '10:00', tone: 'good', text: `Лучше всего линия: ${getHeroName(best.player.hero_id)} впереди ${getHeroName(best.rival.hero_id)} на ${best.gap.toLocaleString()} нетворса.` });
    }
  }

  const swing = caseSwing(match, side);
  if (swing) {
    const from = swing.from * 60;
    const to = swing.to * 60;
    const ours = caseDeathsBetween(match, side.allies, from, to);
    const theirs = caseDeathsBetween(match, side.enemies, from, to);
    const count = list => list.reduce((sum, row) => sum + row.count, 0);
    const deaths = ours.length > 0 ? ` Смерти: ${caseDeathList(ours)}.` : ' Смертей в команде нет: перевес ушёл на фарме и объектах.';
    rows.push({
      time: from,
      label: `${swing.from}–${swing.to} мин`,
      tone: side.won ? 'good' : 'bad',
      text: side.won
        ? `Лучшие 5 минут: команда взяла +${analystThousands(swing.change)} нетворса, убийств ${count(theirs)}, своих смертей ${count(ours)}.`
        : `Самые дорогие 5 минут: команда отдала ${analystThousands(swing.change)} нетворса, убила врагов: ${count(theirs)}.${deaths}`
    });
  }

  const turn = analystTurningPoint(match, side);
  if (turn) rows.push({ time: Number(turn.text.match(/\d+/)[0]) * 60, label: `${turn.text.match(/\d+/)[0]} мин`, tone: turn.tone, text: turn.text.replace(/^Перелом на \d+ минуте: /, 'Перелом: ') });

  (match.objectives || [])
    .filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL')
    .forEach(o => {
      const ours = o.team === (side.radiant ? 2 : 3);
      rows.push({ time: o.time, label: formatClock(o.time), tone: ours ? 'good' : 'bad', text: `Рошана забрала ${ours ? 'твоя команда' : 'команда врага'}.` });
    });

  const towers = analystSum(side.allies, 'tower_damage');
  const enemyTowers = analystSum(side.enemies, 'tower_damage');
  rows.push({
    time: match.duration || 0,
    label: formatMatchDuration(match.duration),
    tone: side.won ? 'good' : 'bad',
    text: `Финал: ${analystSum(side.allies, 'kills')} : ${analystSum(side.enemies, 'kills')} по убийствам, ${towers.toLocaleString()} против ${enemyTowers.toLocaleString()} урона по строениям.`
  });

  return { won: side.won, rows: rows.sort((a, b) => a.time - b.time) };
}

function renderMatchStoryBlock(m) {
  const box = document.getElementById('rp-why');
  if (!box) return;
  const live = getLiveMatchData(m);
  const hasDetails = live && live.match.details;
  box.classList.toggle('hidden', !hasDetails);
  if (!hasDetails) return;
  const story = buildMatchStory(live.match, live.player);
  box.innerHTML = `
    <h4>${story.won ? 'Почему мы выиграли' : 'Почему мы проиграли'}</h4>
    <div class="case-list">${story.rows.map(row => caseRow(row.label, row.text, row.tone, row.time)).join('')}</div>`;
}

function caseRow(label, text, tone, time) {
  const jump = time != null ? `onclick="replayJump(${Math.max(0, Math.round(time))})"` : '';
  return `<button type="button" class="case-row ${tone || ''}" ${jump}><strong>${esc(label)}</strong><span>${esc(text)}</span></button>`;
}

// ─── Досье игрока ───────────────────────────────────────────────────────

function buildPlayerCase(match, player) {
  const detail = playerDetail(match, player);
  if (!detail) return null;
  const side = analystSide(match, player);
  const team = side.allies;
  const reasons = [];
  const add = (bad, score, title, text) => reasons.push({ bad, score, title, text });

  const imps = team
    .map(p => ({ player: p, imp: (playerDetail(match, p) || {}).imp }))
    .filter(row => row.imp != null)
    .sort((a, b) => b.imp - a.imp);
  const place = imps.findIndex(row => row.player === player) + 1;
  if (detail.imp != null && imps.length > 1) {
    const worst = place === imps.length;
    const mean = Math.round(average(imps.map(row => row.imp)));
    add(worst, worst ? 10 : place === 1 ? -10 : 0, `Вклад в матч: IMP ${detail.imp}, ${place}-е место из ${imps.length} в команде`, `В среднем у команды ${mean}.`);
  }

  const details = team.map(p => playerDetail(match, p)).filter(Boolean);
  const fedOf = row => row.deaths.reduce((sum, d) => sum + (d.goldFed || 0), 0);
  const fed = fedOf(detail);
  const teamFed = details.reduce((sum, row) => sum + fedOf(row), 0);
  if (fed > 0) {
    const share = Math.round((fed / Math.max(1, teamFed)) * 100);
    add(share >= 25, share / 4, `Отдал врагу ${fed.toLocaleString()} золота за ${detail.deaths.length} смертей`, `Это ${share}% всего золота, которое враг получил с команды.`);
  }

  const dead = detail.deaths.reduce((sum, d) => sum + (d.timeDead || 0), 0);
  if (dead > 0 && match.duration) {
    const share = Math.round((dead / match.duration) * 100);
    add(share >= 12, share / 2, `Мёртв ${dead} секунд`, `Это ${share}% времени матча без героя на карте.`);
  }

  const kills = team.flatMap(p => {
    const row = playerDetail(match, p);
    return row ? row.kills.map(kill => kill.time) : [];
  });
  if (detail.deaths.length > 0) {
    const lost = detail.deaths.filter(d => !kills.some(time => Math.abs(time - d.time) <= ANALYST_TRADE_SECONDS)).length;
    add(lost / detail.deaths.length >= 0.5, (lost / detail.deaths.length) * 5, `Смертей без размена: ${lost} из ${detail.deaths.length}`, 'Команда никого не убила в 15 секундах от смерти.');
  }

  const teamKills = analystSum(team, 'kills');
  if (teamKills > 0) {
    const share = Math.round((((player.kills || 0) + (player.assists || 0)) / teamKills) * 100);
    add(share < 45, (60 - share) / 10, `Участие в убийствах: ${share}%`, `${player.kills || 0} убийств и ${player.assists || 0} помощи, у команды ${teamKills} убийств.`);
  }

  const rival = player.position ? side.enemies.find(p => p.position === player.position) : null;
  const rivalDetail = rival ? playerDetail(match, rival) : null;
  if (rivalDetail && detail.networth.length > 10 && rivalDetail.networth.length > 10) {
    const gap = detail.networth[10] - rivalDetail.networth[10];
    add(gap < 0, -gap / 500, `Линия: ${gap >= 0 ? '+' : '−'}${Math.abs(gap).toLocaleString()} нетворса к 10 минуте`, `${detail.networth[10].toLocaleString()} против ${rivalDetail.networth[10].toLocaleString()} у ${getHeroName(rival.hero_id)}.`);
  }

  const others = team.filter(p => p !== player);
  const gpm = analystMean(others, 'gold_per_min');
  if (player.gold_per_min && gpm) {
    add(player.gold_per_min < gpm, (gpm - player.gold_per_min) / 60, `GPM ${player.gold_per_min}, у союзников в среднем ${gpm}`, `XPM ${player.xp_per_min || 0}.`);
  }

  return {
    reasons: reasons.sort((a, b) => b.score - a.score).slice(0, CASE_MAX_REASONS),
    timeline: buildPlayerTimeline(match, player, detail)
  };
}

function buildPlayerTimeline(match, player, detail) {
  const rows = [];
  detail.deaths.forEach(death => {
    const killer = HEROES_DB[death.attacker] ? getHeroName(death.attacker) : 'крипы или башня';
    const place = death.positionX != null ? `, ${mapZone(mapPoint(death.positionX, death.positionY).x, mapPoint(death.positionX, death.positionY).y).toLowerCase()}` : '';
    const reasons = deathReasons(death);
    rows.push({
      time: death.time,
      tone: 'bad',
      text: `Умер: ${killer}${place}. Враг получил ${(death.goldFed || 0).toLocaleString()} золота${death.timeDead ? `, респаун ${death.timeDead} сек` : ''}${reasons.length > 0 ? `. ${reasons[0]}` : ''}.`
    });
  });
  detail.kills.forEach(kill => {
    const name = HEROES_DB[kill.target] ? getHeroName(kill.target) : 'врага';
    rows.push({ time: kill.time, tone: 'good', text: `Убил ${name}${kill.isSolo ? ' в соло' : ''}${kill.isGank ? ', ганк' : ''}${kill.isSmoke ? ' под смоком' : ''}.` });
  });
  analystKeyTimings(match, player, CASE_TIMELINE_ITEMS).forEach(item => {
    rows.push({ time: item.time, tone: '', text: `Купил ${draftItemTitle(item.key)}.` });
  });
  return rows.sort((a, b) => a.time - b.time);
}

function caseHeading(player, match) {
  const side = analystSide(match, player);
  const list = side.allies
    .map(p => ({ player: p, imp: (playerDetail(match, p) || {}).imp }))
    .filter(row => row.imp != null)
    .sort((a, b) => a.imp - b.imp);
  if (list.length < 2) return 'Что сделал игрок';
  if (list[0].player === player && !side.won) return 'Почему он главный руинер';
  if (list[list.length - 1].player === player) return side.won ? 'Почему он лучший в победе' : 'Почему он лучший в поражении';
  return 'Что сделал игрок';
}

function renderPlayerCase(slot) {
  const box = document.getElementById('rp-culprit-reasons');
  const m = currentActiveReplayMatch;
  const live = m ? getLiveMatchData(m) : null;
  if (!box || !live) return;
  const player = live.match.players.find(p => p.player_slot === slot);
  if (!player) return;
  const result = buildPlayerCase(live.match, player);
  if (!result) return;

  box.innerHTML = `
    <h4 class="case-title">${esc(caseHeading(player, live.match))}</h4>
    <div class="case-reasons">
      ${result.reasons.map(reason => `
        <div class="case-reason ${reason.bad ? 'bad' : 'good'}"><strong>${esc(reason.title)}</strong><span>${esc(reason.text)}</span></div>`).join('')}
    </div>
    <h4 class="case-title">Весь матч по времени</h4>
    <div class="case-list scroll">${result.timeline.map(row => caseRow(formatClock(row.time), row.text, row.tone, row.time)).join('') || '<p class="text-sm text-slate-400">Событий нет.</p>'}</div>
    <p class="text-xs text-slate-400">Нажми на строку, чтобы открыть этот момент на карте.</p>`;
}

function renderEnemyChips(m) {
  const box = document.getElementById('rp-enemies-grid');
  if (!box) return;
  const live = getLiveMatchData(m);
  if (!live) {
    box.innerHTML = '';
    return;
  }
  const side = analystSide(live.match, live.player);
  box.innerHTML = side.enemies.map(player => `
    <button type="button" class="case-enemy" onclick="openEnemyDossier(${player.player_slot})">
      <img loading="lazy" decoding="async" src="${getHeroIcon(player.hero_id)}" alt="">
      <span>${esc(getHeroName(player.hero_id))}</span>
      <small>${player.kills || 0}/${player.deaths || 0}/${player.assists || 0}</small>
    </button>`).join('');
}

function openEnemyDossier(slot) {
  const live = currentActiveReplayMatch ? getLiveMatchData(currentActiveReplayMatch) : null;
  if (!live) return;
  const player = live.match.players.find(p => p.player_slot === slot);
  if (!player) return;
  const name = getHeroName(player.hero_id);
  const nick = player.personaname || 'Аноним';
  const set = (id, text) => {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  };
  set('rp-culprit-header-title', `Досье игрока: ${name} • ${nick}`);
  set('rp-culprit-badge', 'ВРАГ');
  set('rp-culprit-role-badge', player.position ? POSITION_NAMES[player.position] : 'Враг');
  set('rp-culprit-name', `${name} (${nick})`);
  set('rp-culprit-kda', `${player.kills || 0}/${player.deaths || 0}/${player.assists || 0}`);
  set('rp-culprit-summary', `Нетворс: ${formatStat(player.net_worth)} • GPM: ${player.gold_per_min || 0} • Урон вышкам: ${formatStat(player.tower_damage)}`);
  const image = document.getElementById('rp-culprit-img');
  if (image) image.src = getHeroIcon(player.hero_id);
  renderPlayerCase(slot);
  document.getElementById('rp-culprit-header-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
