'use strict';

// 2D-повтор: настоящие позиции героев из реплея (STRATZ) на нашей схеме карты.
// Это не видео из игры: видео может сделать только клиент Dota, а здесь точки каждые 5 секунд.

const REPLAY_SPEEDS = [8, 16, 32];
const REPLAY_MARK_SECONDS = 10;
const REPLAY_FEED_ITEMS = 4;
const REPLAY_NEAR_CELLS = 12; // примерно 1500 единиц на карте: дальность драки
const REPLAY_LOOK_BACK = 3;
const REPLAY_FIGHT_WINDOW = 30;
const REPLAY_FIGHT_DEATHS = 3;
const REPLAY_FAR_CELLS = 35;
const REPLAY_RICH_GOLD = 300;
const REPLAY_CELL_TO_MAP = 100 / MAP_SIZE;

const replay = {
  match: null,
  viewer: null,
  heroes: null,
  wards: [],
  deaths: [],
  time: 0,
  start: 0,
  end: 0,
  speed: 16,
  playing: false,
  frame: null,
  last: 0,
  matchId: null,
  token: 0,
  focus: null,
  moments: [],
  open: null,
  passed: null,
  tickFrom: 0,
  pauseOnMistakes: true
};

function replayPosition(points, time) {
  if (!points || points.length === 0) return null;
  if (time <= points[0][0]) return { x: points[0][1], y: points[0][2] };
  for (let i = 1; i < points.length; i++) {
    if (time <= points[i][0]) {
      const [fromTime, fromX, fromY] = points[i - 1];
      const [toTime, toX, toY] = points[i];
      const share = toTime === fromTime ? 0 : (time - fromTime) / (toTime - fromTime);
      return { x: fromX + (toX - fromX) * share, y: fromY + (toY - fromY) * share };
    }
  }
  const last = points[points.length - 1];
  return { x: last[1], y: last[2] };
}

function replayIsDead(deaths, heroId, time) {
  return deaths.some(row => row.hero === heroId && time >= row.time && time < row.time + (row.timeDead || 0));
}

function replayFeed(deaths, time) {
  return deaths
    .filter(row => row.time <= time)
    .slice(-REPLAY_FEED_ITEMS)
    .reverse();
}

function replayPlayer(heroId) {
  return replay.match.players.find(player => player.hero_id === heroId) || replay.viewer;
}

// ─── Разбор момента ─────────────────────────────────────────────────────

// Кто стоял рядом. Позиции идут раз в 5 секунд, поэтому это оценка.
function replayNearby(focus, time) {
  const from = replayPosition(replay.heroes[focus.hero_id], time);
  const near = { allies: [], enemies: [] };
  if (!from) return near;
  const radiant = focus.player_slot < 128;
  replay.match.players.forEach(player => {
    if (player === focus || replayIsDead(replay.deaths, player.hero_id, time)) return;
    const point = replayPosition(replay.heroes[player.hero_id], time);
    if (!point || Math.hypot(point.x - from.x, point.y - from.y) > REPLAY_NEAR_CELLS) return;
    near[(player.player_slot < 128) === radiant ? 'allies' : 'enemies'].push(player);
  });
  return near;
}

function replayOnEnemyHalf(row, radiant) {
  return radiant ? row.x > row.y + MAP_RIVER_WIDTH : row.y > row.x + MAP_RIVER_WIDTH;
}

function replayDeathMoment(row, focus) {
  const raw = row.raw;
  const near = replay.heroes ? replayNearby(focus, row.time - REPLAY_LOOK_BACK) : null;
  const allies = near ? near.allies.length : 0;
  const enemies = near ? near.enemies.length : 0;
  const wrong = [];
  const fix = [];
  const add = (problem, advice) => {
    wrong.push(problem);
    if (!fix.includes(advice)) fix.push(advice);
  };

  if (near && enemies >= 2 && allies === 0) {
    add(`Один против ${enemies} врагов, союзников рядом нет.`, 'Не ходить одному туда, где не видно врагов: держаться ближе к команде или сначала поставить вард.');
  } else if (near && enemies > allies + 1) {
    add(`Драка ${allies + 1} на ${enemies}: врагов больше.`, 'Не принимать драку в меньшинстве: отойти к вышке или союзникам и дождаться команды.');
  }
  if (replayOnEnemyHalf(row, focus.player_slot < 128)) {
    add('Смерть на чужой половине карты.', 'Заходить на чужую половину только с командой и когда враги видны на карте.');
  }
  if (raw.isEngagedOnDeath === false) add('Поймали вне драки.', 'Перед фармом смотреть на карту: если врагов не видно, они могут идти к тебе.');
  if (raw.hasHealAvailable) add('Лечение было готово, но его не нажали.', 'Нажимать лечение раньше, пока здоровья ещё половина.');
  if (raw.isBurst) add('Убили за секунды.', 'Стоять дальше от врагов в начале драки и раньше купить предмет на выживание.');
  if (raw.isAttemptTpOut) add('Пытался уйти телепортом, но не успел.', 'Нажимать телепорт заранее, пока враги ещё не рядом.');
  if (raw.isDieBack) add('Умер почти сразу после возвращения в игру.', 'После возрождения не лететь сразу в ту же драку: сначала посмотреть, кто где.');
  if ((raw.goldLost || 0) >= REPLAY_RICH_GOLD) add(`Сгорело ${raw.goldLost.toLocaleString()} золота из кармана.`, 'Тратить золото перед дракой: купить предмет, расходники или выкуп.');
  if (row.time < 600) add('Смерть в первые 10 минут.', 'На линии не заходить за крипов, пока не видно всех врагов на карте.');

  const killer = row.killer ? getHeroName(row.killer) : 'крипы или башня';
  const around = near ? `Рядом за ${REPLAY_LOOK_BACK} секунды до смерти: союзников ${allies}, врагов ${enemies}. ` : '';
  return {
    time: row.time,
    title: `${getHeroName(row.hero)} умер: ${killer}, ${row.zone.toLowerCase()}`,
    wrong: wrong.length > 0 ? wrong : ['Явной ошибки в данных не видно.'],
    fix: fix.length > 0 ? fix : ['Посмотри этот момент в игре: возможно, это был нужный размен.'],
    cost: `${around}Враг получил ${(row.goldFed || 0).toLocaleString()} золота, респаун ${row.timeDead || 0} сек.`,
    near: near || { allies: [], enemies: [] }
  };
}

// Команда потеряла несколько героев, а игрок был жив и далеко
function replayMissedFights(focus) {
  const radiant = focus.player_slot < 128;
  const viewerRadiant = replay.viewer.player_slot < 128;
  const team = replay.deaths.filter(row => row.ally === (radiant === viewerRadiant) && row.hero !== focus.hero_id);
  const moments = [];
  let index = 0;
  while (index < team.length) {
    const first = team[index];
    const group = team.filter(row => row.time >= first.time && row.time <= first.time + REPLAY_FIGHT_WINDOW);
    if (group.length >= REPLAY_FIGHT_DEATHS && !replayIsDead(replay.deaths, focus.hero_id, first.time)) {
      const point = replayPosition(replay.heroes[focus.hero_id], first.time);
      const distance = point ? Math.hypot(point.x - first.raw.positionX, point.y - first.raw.positionY) : 0;
      if (distance >= REPLAY_FAR_CELLS) {
        const where = mapPoint(point.x, point.y);
        moments.push({
          time: first.time,
          title: `Команда потеряла ${group.length} героев без ${getHeroName(focus.hero_id)}`,
          wrong: [`Драка шла здесь: ${first.zone.toLowerCase()}. Герой был далеко: ${mapZone(where.x, where.y).toLowerCase()}.`],
          fix: ['Чаще смотреть на карту: когда союзники собираются, идти к ним. Если не успеть, давить другую линию.'],
          cost: `Умерли: ${group.map(row => getHeroName(row.hero)).join(', ')}.`,
          near: { allies: [], enemies: [] }
        });
      }
    }
    index += Math.max(1, group.length);
  }
  return moments;
}

function buildReplayMoments(focus) {
  if (!replay.heroes) return [];
  const deaths = replay.deaths.filter(row => row.hero === focus.hero_id).map(row => replayDeathMoment(row, focus));
  return [...deaths, ...replayMissedFights(focus)].sort((a, b) => a.time - b.time);
}

function momentHtml(moment, heading, button) {
  const list = items => `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
  return `
    <div class="replay-moment">
      <div class="replay-moment-head">
        <span>${esc(heading)}</span>
        <strong>${esc(moment.title)}</strong>
      </div>
      <h5>Что не так</h5>${list(moment.wrong)}
      <h5>Что нужно было сделать</h5>${list(moment.fix)}
      <p>${esc(moment.cost)}</p>
      ${button}
    </div>`;
}

function replayShowMoment(index) {
  const moment = replay.moments[index];
  const box = document.getElementById('replay-moment');
  replay.open = moment ? index : null;
  box.innerHTML = moment
    ? momentHtml(moment, `Ошибка ${index + 1} из ${replay.moments.length} • ${formatClock(moment.time)}`, '<button type="button" class="pro-btn" onclick="replayContinue()">Дальше</button>')
    : '';
  document.querySelectorAll('.replay-step').forEach((button, step) => button.classList.toggle('active', step === index));
  replayDraw();
}

function replayRefreshMoments() {
  replay.moments = buildReplayMoments(replayPlayer(replay.focus));
  replay.open = null;
  const span = Math.max(1, replay.end - replay.start);
  document.getElementById('replay-ticks').innerHTML = replay.moments
    .map(moment => `<i style="left:${((moment.time - replay.start) / span) * 100}%"></i>`).join('');
  document.getElementById('replay-steps').innerHTML = replay.moments
    .map((moment, index) => `<button type="button" class="replay-step" onclick="replayOpenMoment(${index})">${esc(formatClock(moment.time))}</button>`).join('')
    || '<p class="text-xs text-slate-400">У этого игрока нет смертей и пропущенных драк.</p>';
  document.getElementById('replay-moment').innerHTML = '';
}

function replaySetFocus(heroId) {
  replayStop();
  replay.focus = Number(heroId);
  replay.passed = replay.time;
  replayRefreshMoments();
  replayDraw();
}

function replaySetPause(checked) {
  replay.pauseOnMistakes = checked;
}

function replayOpenMoment(index) {
  const moment = replay.moments[index];
  if (!moment) return;
  replayStop();
  replay.time = moment.time;
  replay.passed = moment.time;
  replayShowMoment(index);
}

function replayContinue() {
  replayShowMoment(-1);
  replayToggle();
}

function replayMomentInStep(from, to) {
  return replay.moments.findIndex(moment => moment.time > from && moment.time <= to && moment.time > (replay.passed ?? -Infinity));
}

// ─── Экран повтора ──────────────────────────────────────────────────────

function renderReplayShell() {
  const box = document.getElementById('rp-replay-stage');
  const size = 7;
  const pins = replay.match.players.map(player => {
    const ally = (player.player_slot < 128) === (replay.viewer.player_slot < 128);
    const color = player === replay.viewer ? '#FFFFFF' : ally ? '#34D399' : '#F87171';
    return `
      <g id="replay-hero-${player.hero_id}" class="replay-hero">
        <title>${esc(getHeroName(player.hero_id))}</title>
        <circle r="${size / 2 + 0.5}" fill="#0A0B10" stroke="${color}" stroke-width=".9"/>
        <image href="${getHeroIcon(player.hero_id)}" x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#replay-pin)"/>
      </g>`;
  }).join('');

  box.innerHTML = `
    <div class="map-wrap">
      <svg class="death-map" viewBox="0 0 100 100" role="img" aria-label="2D-повтор матча">
        ${mapBackground('replay')}
        <g id="replay-wards"></g>
        <g id="replay-marks"></g>
        ${pins}
      </svg>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <button id="replay-play" type="button" class="pro-btn" onclick="replayToggle()">Смотреть</button>
          ${REPLAY_SPEEDS.map(speed => `<button type="button" class="pro-pill plain ${speed === replay.speed ? 'active' : ''}" data-speed="${speed}" onclick="replaySpeed(${speed})">×${speed}</button>`).join('')}
          <strong id="replay-clock" class="text-white"></strong>
        </div>
        <div class="replay-range">
          <input id="replay-range" type="range" class="w-full" min="${replay.start}" max="${replay.end}" value="${replay.time}" aria-label="Время матча" oninput="replaySeek(Number(this.value))">
          <div id="replay-ticks" aria-hidden="true"></div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <select class="pro-input replay-focus" aria-label="Чьи ошибки показывать" onchange="replaySetFocus(this.value)">
            ${replay.match.players.map(player => `<option value="${player.hero_id}" ${player.hero_id === replay.focus ? 'selected' : ''}>${esc(getHeroName(player.hero_id))}${player === replay.viewer ? ' (ты)' : ''}</option>`).join('')}
          </select>
          <label class="replay-check"><input type="checkbox" ${replay.pauseOnMistakes ? 'checked' : ''} onchange="replaySetPause(this.checked)"> Пауза на ошибках</label>
        </div>
        <div id="replay-steps" class="replay-steps"></div>
        <div id="replay-moment" aria-live="polite"></div>
        <div id="replay-feed" class="space-y-1" aria-live="off"></div>
        <p class="text-xs text-slate-400">Белая рамка: ты, зелёная: союзники, красная: враги. Жёлтые ромбы: обзорные варды, синие: сентри. Советы составлены по данным матча, позиции примерные.</p>
      </div>
    </div>`;
  replayRefreshMoments();
  replayDraw();
}

// На паузе показываем линиями, кто стоял рядом с героем
function replayMomentLines(time) {
  const moment = replay.moments[replay.open];
  if (!moment) return '';
  const focus = replayPlayer(replay.focus);
  const from = replayPosition(replay.heroes[focus.hero_id], time);
  if (!from) return '';
  const start = mapPoint(from.x, from.y);
  const line = (player, color) => {
    const point = replayPosition(replay.heroes[player.hero_id], time);
    if (!point) return '';
    const end = mapPoint(point.x, point.y);
    return `<line x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" stroke="${color}" stroke-width=".6" stroke-dasharray="1.4 1"/>`;
  };
  return `${moment.near.enemies.map(player => line(player, '#F87171')).join('')}${moment.near.allies.map(player => line(player, '#34D399')).join('')}
    <circle cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="${(REPLAY_NEAR_CELLS * REPLAY_CELL_TO_MAP).toFixed(1)}" fill="#FDE047" fill-opacity=".1" stroke="#FDE047" stroke-opacity=".7" stroke-width=".4"/>`;
}

function replayDraw() {
  const time = replay.time;
  replay.match.players.forEach(player => {
    const pin = document.getElementById(`replay-hero-${player.hero_id}`);
    if (!pin) return;
    const position = replayPosition(replay.heroes && replay.heroes[player.hero_id], time);
    if (!position) {
      pin.setAttribute('visibility', 'hidden');
      return;
    }
    const { x, y } = mapPoint(position.x, position.y);
    pin.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    pin.setAttribute('opacity', replayIsDead(replay.deaths, player.hero_id, time) ? '.25' : '1');
  });

  const marks = replay.deaths
    .filter(row => row.time <= time && time - row.time <= REPLAY_MARK_SECONDS)
    .map(row => `<path d="M${(row.x - 2).toFixed(1)} ${(row.y - 2).toFixed(1)} l4 4 m0 -4 l-4 4" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/>`)
    .join('');
  document.getElementById('replay-marks').innerHTML = marks + replayMomentLines(time);
  document.getElementById('replay-wards').innerHTML = replay.wards
    .filter(ward => ward.time <= time && time < ward.end)
    .map(ward => wardIcon(ward))
    .join('');

  document.getElementById('replay-clock').textContent = formatClock(Math.round(time));
  document.getElementById('replay-range').value = Math.round(time);
  document.getElementById('replay-feed').innerHTML = replayFeed(replay.deaths, time).map(row => `
    <p class="text-xs text-slate-300"><strong class="text-white">${esc(formatClock(row.time))}</strong> ${row.killer ? `${esc(getHeroName(row.killer))} убил ${esc(getHeroName(row.hero))}` : `${esc(getHeroName(row.hero))} умер`}, ${esc(row.zone.toLowerCase())}</p>`).join('');
}

function replayTick(now) {
  if (!replay.playing) return;
  const seconds = (now - replay.last) / 1000;
  replay.last = now;
  const from = replay.time;
  replay.time = Math.min(replay.end, replay.time + seconds * replay.speed);

  if (replay.pauseOnMistakes) {
    const index = replayMomentInStep(from, replay.time);
    if (index >= 0) {
      replay.time = replay.moments[index].time;
      replay.passed = replay.time;
      replayStop();
      replayShowMoment(index);
      return;
    }
  }
  replayDraw();
  if (replay.time >= replay.end) {
    replayStop();
    return;
  }
  replay.frame = requestAnimationFrame(replayTick);
}

function replayStop() {
  replay.playing = false;
  if (replay.frame) cancelAnimationFrame(replay.frame);
  const button = document.getElementById('replay-play');
  if (button) button.textContent = 'Смотреть';
}

function replayToggle() {
  if (replay.playing) {
    replayStop();
    return;
  }
  if (replay.time >= replay.end) {
    replay.time = replay.start;
    replay.passed = null;
  }
  if (replay.open != null) replayShowMoment(-1);
  replay.playing = true;
  replay.last = performance.now();
  document.getElementById('replay-play').textContent = 'Пауза';
  replay.frame = requestAnimationFrame(replayTick);
}

function replaySpeed(speed) {
  replay.speed = speed;
  document.querySelectorAll('[data-speed]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.speed) === speed);
  });
}

function replaySeek(time) {
  replay.time = time;
  replay.passed = time - 1;
  if (replay.open != null) replayShowMoment(-1);
  replayDraw();
}

async function replayFetch(m) {
  const live = getLiveMatchData(m);
  if (!live) return false;
  if (replay.matchId === m.match_id && replay.heroes) return true;
  const token = ++replay.token;
  const data = await proFetchJson(`/playback/${m.match_id}`);
  if (token !== replay.token) return false;

  replay.match = live.match;
  replay.viewer = live.player;
  replay.heroes = data && data.heroes ? data.heroes : null;
  replay.wards = wardList(data && data.wards, live.match);
  replay.deaths = matchDeaths(live.match, live.player);
  replay.matchId = m.match_id;
  replay.start = 0;
  replay.end = live.match.duration || 0;
  replay.time = 0;
  replay.passed = null;
  replay.focus = live.player.hero_id;
  return !!replay.heroes;
}

async function replayLoad(m) {
  const status = document.getElementById('rp-replay-status');
  const button = document.getElementById('rp-replay-load');
  status.textContent = 'Загружаю позиции героев...';
  button.disabled = true;
  const loaded = await replayFetch(m);
  button.disabled = false;
  if (!loaded) {
    status.textContent = 'Для этого матча нет позиций героев. Такое бывает, пока STRATZ не разобрал реплей. Попробуй через пару минут.';
    return false;
  }
  status.textContent = '';
  button.classList.add('hidden');
  renderReplayShell();
  return true;
}

function replayLoadCurrent() {
  if (currentActiveReplayMatch) replayLoad(currentActiveReplayMatch);
}

// Переход с небольшим запасом, чтобы увидеть, что было до момента
async function replayJump(time) {
  const m = currentActiveReplayMatch;
  if (!m) return;
  if (!document.getElementById('replay-play')) {
    const loaded = await replayLoad(m);
    if (!loaded) return;
  }
  replayStop();
  replaySeek(Math.max(replay.start, time - REPLAY_MARK_SECONDS));
  document.getElementById('rp-replay').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderReplayCard(m) {
  const card = document.getElementById('rp-replay');
  if (!card) return;
  const live = getLiveMatchData(m);
  card.classList.toggle('hidden', !(live && live.match.details));
  if (replay.matchId === m.match_id) return;

  replayStop();
  replay.token += 1;
  replay.matchId = null;
  replay.heroes = null;
  replay.wards = [];
  document.getElementById('rp-replay-stage').innerHTML = '';
  document.getElementById('rp-replay-status').textContent = '';
  const button = document.getElementById('rp-replay-load');
  button.classList.remove('hidden');
  button.disabled = false;
}
