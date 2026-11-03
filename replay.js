'use strict';

// Разбор на карте: настоящие позиции героев, здоровье, здания, Рошан, руны и варды из реплея (STRATZ).
// Это не видео из игры: видео может сделать только клиент Dota, здесь точки идут раз в 5 секунд.

const REPLAY_SPEEDS = [8, 16, 32];
const REPLAY_MARK_SECONDS = 10;
const REPLAY_NEAR_CELLS = 12; // примерно 1500 единиц на карте: дальность драки
const REPLAY_LOOK_BACK = 3;
const REPLAY_FIGHT_WINDOW = 30;
const REPLAY_FIGHT_DEATHS = 3;
const REPLAY_FAR_CELLS = 35;
const REPLAY_RICH_GOLD = 300;
const REPLAY_CELL_TO_MAP = 100 / MAP_SIZE;
const REPLAY_HERO_VISION = 9; // в процентах карты, примерно 1500 единиц
const REPLAY_SPOT_FROM = 25;
const REPLAY_SPOT_TO = 6;
const REPLAY_SPOT_STEP = 5;
const REPLAY_SPOT_CELLS = 25;
const REPLAY_SPOT_SECONDS = 10;
const REPLAY_MOVED_CELLS = 5;
const REPLAY_FOG_CHECKS = [8, 4];
const REPLAY_MOMENTS_MAX = 10;
const REPLAY_GOOD_MAX = 2;
const REPLAY_ROSHAN_CELLS = 15;
const REPLAY_CLUSTER_SHARE = 2.2;
const REPLAY_HP_BEFORE = 5;
const REPLAY_PIN = 6;
const REPLAY_HEAL_ITEMS = {
  magic_stick: 'Мгновенное лечение: жми его, как только начали бить, а не на последних процентах.',
  magic_wand: 'Мгновенное лечение: жми его, как только начали бить, а не на последних процентах.',
  flask: 'Салве надо пить до начала драки: любой урон его сбивает.',
  faerie_fire: 'Faerie Fire лечит сразу: держи его для последних процентов здоровья.',
  enchanted_mango: 'Mango лечит сразу: это запас на крайний случай, жми без раздумий.',
  bottle: 'Заряды Bottle лечат даже в драке: нажимай их заранее.',
  mekansm: 'Mekansm лечит всю команду: жми в начале драки.',
  guardian_greaves: 'Greaves снимают эффекты и лечат: жми в начале драки.',
  satanic: 'Satanic надо жать, пока ты бьёшь врага: он возвращает здоровье ударами.'
};
const REPLAY_SAVE_ITEMS = {
  black_king_bar: 70, blink: 15, overwhelming_blink: 15, swift_blink: 15, arcane_blink: 15, force_staff: 19, hurricane_pike: 19,
  glimmer_cape: 14, ghost: 22, cyclone: 23, wind_waker: 23, invis_sword: 28, silver_edge: 20, lotus_orb: 15, manta: 30, sphere: 0
};
const REPLAY_CATEGORIES = { hero: 'Игра на герое', fight: 'Тимфайты и позиционирование', map: 'Карта и обзор', lane: 'Линия', team: 'Командная игра' };

const replay = {
  match: null,
  viewer: null,
  heroes: null,
  wards: [],
  deaths: [],
  buildings: [],
  roshan: { spots: [], deaths: [] },
  runes: [],
  couriers: [],
  health: {},
  loadouts: {},
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
  pauseOnMistakes: true,
  observer: null,
  feedLock: 0,
  drawnBuildings: '',
  drawnWards: '',
  watcher: null
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

function replayHealth(heroId, time) {
  const points = replay.health[heroId];
  if (!points || points.length === 0) return null;
  let value = points[0][1];
  for (const [pointTime, percent] of points) {
    if (pointTime > time) break;
    value = percent;
  }
  return value;
}

function replayIsDead(deaths, heroId, time) {
  return deaths.some(row => row.hero === heroId && time >= row.time && time < row.time + (row.timeDead || 0));
}

function replayPlayer(heroId) {
  return replay.match.players.find(player => player.hero_id === heroId) || replay.viewer;
}

function replayIsViewer(focus) {
  return focus === replay.viewer;
}

function replaySame(a, b) {
  return (a.player_slot < 128) === (b.player_slot < 128);
}

function replayMapPoint(heroId, time) {
  const position = replayPosition(replay.heroes && replay.heroes[heroId], time);
  return position ? mapPoint(position.x, position.y) : null;
}

// ─── Что видела команда ─────────────────────────────────────────────────

// Туман считаем сами: герой видит примерно 1500 единиц, обзорный вард 1600. Деревья и высоты здесь не учтены.
function replaySeesPoint(team, point, time) {
  const byWard = replay.wards.some(ward => ward.type === 'OBSERVER' && ward.radiant === (team.player_slot < 128)
    && ward.time <= time && time < ward.end && Math.hypot(ward.x - point.x, ward.y - point.y) <= WARD_VISION);
  if (byWard) return 'ward';
  const byHero = replay.match.players.some(player => {
    if (!replaySame(player, team) || replayIsDead(replay.deaths, player.hero_id, time)) return false;
    const other = replayMapPoint(player.hero_id, time);
    return other && Math.hypot(other.x - point.x, other.y - point.y) <= REPLAY_HERO_VISION;
  });
  return byHero ? 'hero' : null;
}

// ─── Разбор момента ─────────────────────────────────────────────────────

// Кто стоял рядом. Позиции идут раз в 5 секунд, поэтому это оценка.
function replayNearby(focus, time) {
  const from = replayPosition(replay.heroes[focus.hero_id], time);
  const near = { allies: [], enemies: [] };
  if (!from) return near;
  replay.match.players.forEach(player => {
    if (player === focus || replayIsDead(replay.deaths, player.hero_id, time)) return;
    const point = replayPosition(replay.heroes[player.hero_id], time);
    if (!point || Math.hypot(point.x - from.x, point.y - from.y) > REPLAY_NEAR_CELLS) return;
    near[replaySame(player, focus) ? 'allies' : 'enemies'].push(player);
  });
  return near;
}

function replayOnEnemyHalf(row, radiant) {
  return radiant ? row.x > row.y + MAP_RIVER_WIDTH : row.y > row.x + MAP_RIVER_WIDTH;
}

function replayLoadout(heroId, time) {
  const list = replay.loadouts[heroId] || [];
  return list.find(entry => entry.time === time) || null;
}

function replayItemKey(id) {
  return (itemNames && itemNames[id]) || null;
}

// Предмет считается готовым, если его не нажимали дольше перезарядки
function replayUnusedItems(heroId, time) {
  const loadout = replayLoadout(heroId, time);
  if (!loadout) return { heal: [], save: [] };
  const keys = loadout.items.map(([id, charges]) => ({ key: replayItemKey(id), charges })).filter(item => item.key);
  const usedAt = key => loadout.used.filter(([id]) => replayItemKey(id) === key).map(([, at]) => at).pop();
  const heal = keys.filter(({ key, charges }) => {
    if (!REPLAY_HEAL_ITEMS[key]) return false;
    if ((key === 'magic_stick' || key === 'magic_wand' || key === 'bottle') && !(charges > 0)) return false;
    return usedAt(key) == null;
  }).map(({ key }) => key);
  const save = keys.filter(({ key }) => {
    const cooldown = REPLAY_SAVE_ITEMS[key];
    if (!cooldown) return false;
    const used = usedAt(key);
    return used == null || time - used > cooldown;
  }).map(({ key }) => key);
  return { heal, save };
}

function replayNames(players) {
  return players.map(player => getHeroName(player.hero_id)).join(', ');
}

// Враги были видны заранее, а герой всё равно пошёл к ним
function replaySpotted(row, focus) {
  if (!replay.heroes) return null;
  const seen = new Map();
  const place = { x: row.raw.positionX, y: row.raw.positionY };
  for (let back = REPLAY_SPOT_FROM; back >= REPLAY_SPOT_TO; back -= REPLAY_SPOT_STEP) {
    const time = row.time - back;
    replay.match.players.filter(player => !replaySame(player, focus)).forEach(player => {
      const cell = replayPosition(replay.heroes[player.hero_id], time);
      if (!cell || Math.hypot(cell.x - place.x, cell.y - place.y) > REPLAY_SPOT_CELLS) return;
      if (replaySeesPoint(focus, mapPoint(cell.x, cell.y), time) === 'ward') seen.set(player, (seen.get(player) || 0) + REPLAY_SPOT_STEP);
    });
  }
  const players = [...seen.entries()].filter(([, seconds]) => seconds >= REPLAY_SPOT_SECONDS).map(([player]) => player);
  if (players.length === 0) return null;

  const from = replayPosition(replay.heroes[focus.hero_id], row.time - REPLAY_SPOT_FROM);
  const to = replayPosition(replay.heroes[focus.hero_id], row.time - REPLAY_SPOT_TO);
  if (!from || !to) return null;
  const enemy = replayPosition(replay.heroes[players[0].hero_id], row.time - REPLAY_SPOT_TO);
  if (!enemy || Math.hypot(from.x - enemy.x, from.y - enemy.y) - Math.hypot(to.x - enemy.x, to.y - enemy.y) < REPLAY_MOVED_CELLS) return null;
  return { players, seconds: Math.max(...players.map(player => seen.get(player))) };
}

function replayFromFog(row, focus) {
  if (!replay.heroes || !row.killer) return false;
  const killer = replay.heroes[row.killer];
  if (!killer) return false;
  return REPLAY_FOG_CHECKS.every(back => {
    const cell = replayPosition(killer, row.time - back);
    return cell && !replaySeesPoint(focus, mapPoint(cell.x, cell.y), row.time - back);
  });
}

function replayDeathStory(row, focus, near) {
  const viewer = replayIsViewer(focus);
  const name = viewer ? 'Ты' : getHeroName(focus.hero_id);
  const killer = row.killer ? getHeroName(row.killer) : 'крипов или башни';
  const allies = near ? near.allies.length : 0;
  const enemies = near ? near.enemies.length : 0;
  const hp = replayHealth(focus.hero_id, row.time - REPLAY_HP_BEFORE);
  const hpText = hp != null ? `За ${REPLAY_HP_BEFORE} секунд до смерти было ${hp}% здоровья. ` : '';
  const { heal, save } = replayUnusedItems(focus.hero_id, row.time);
  const titles = keys => keys.map(draftItemTitle).join(' и ');

  if (heal.length > 0) {
    return {
      category: 'hero',
      headline: 'Смерть с лечением',
      text: `${hpText}${titles(heal)} ${heal.length > 1 ? 'остались' : 'остался'} ненажатым.`,
      coach: REPLAY_HEAL_ITEMS[heal[0]]
    };
  }
  if (save.length > 0) {
    return {
      category: 'hero',
      headline: `Умер с ${draftItemTitle(save[0])}`,
      text: `${hpText}${titles(save)} ${save.length > 1 ? 'были' : 'был'} готов, но предмет не нажат.`,
      coach: 'Нажимай спасающий предмет в начале захода, до первого оглушения: потом может быть поздно.'
    };
  }
  const spotted = replaySpotted(row, focus);
  if (spotted) {
    return {
      category: 'fight',
      headline: 'Пошёл на замеченных врагов',
      text: `${replayNames(spotted.players)} ${spotted.players.length > 1 ? 'были видны' : 'был виден'} на варде ${spotted.seconds} секунд, но ${name.toLowerCase() === 'ты' ? 'ты' : name} пошёл вперёд и погиб от ${killer}.`,
      coach: 'Когда враги видны заранее, реши сразу: отойти к команде или заходить вместе. Идти одному здесь нельзя.'
    };
  }
  if (replayFromFog(row, focus)) {
    return {
      category: 'map',
      headline: 'Смерть из тумана',
      text: `${killer} подошёл незаметно: за ${REPLAY_FOG_CHECKS[0]} секунд до смерти его не было видно. Враг получил ${(row.goldFed || 0).toLocaleString()} золота.`,
      coach: 'Если этот враг пропал с карты, не стой один. Ставь вард на его подходе или держись ближе к своим.'
    };
  }
  if (near && enemies > allies + 1) {
    return {
      category: 'fight',
      headline: `Драка ${allies + 1} на ${enemies}`,
      text: `Рядом было ${enemies} врагов и ${allies} союзников. Погиб от ${killer}.`,
      coach: 'Не принимай драку в меньшинстве: отойди к вышке или союзникам и дождись команды.'
    };
  }
  if (replayOnEnemyHalf(row, focus.player_slot < 128)) {
    return {
      category: 'fight',
      headline: 'Слишком глубоко',
      text: `Смерть на чужой половине карты: ${row.zone.toLowerCase()}. Погиб от ${killer}.`,
      coach: 'Заходи на чужую половину только с командой и когда враги видны на карте.'
    };
  }
  if (row.time < 600) {
    return {
      category: 'lane',
      headline: 'Смерть на линии',
      text: `Ранняя смерть от ${killer}: ${row.zone.toLowerCase()}. Враг получил ${(row.goldFed || 0).toLocaleString()} золота.`,
      coach: 'На линии не заходи за своих крипов, пока не видно всех врагов.'
    };
  }
  if ((row.raw.goldLost || 0) >= REPLAY_RICH_GOLD) {
    return {
      category: 'hero',
      headline: 'Сгорело золото',
      text: `При смерти потеряно ${row.raw.goldLost.toLocaleString()} золота из кармана.`,
      coach: 'Трать золото перед дракой: купи предмет, расходники или оставь на выкуп.'
    };
  }
  return {
    category: 'fight',
    headline: 'Смерть в драке',
    text: `Погиб от ${killer}: ${row.zone.toLowerCase()}.`,
    coach: 'Посмотри этот момент в игре: возможно, это был нужный размен.'
  };
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
    near: near || { allies: [], enemies: [] },
    tone: 'bad',
    death: true,
    weight: (row.goldFed || 0) + 500,
    hero: focus.hero_id,
    ...replayDeathStory(row, focus, near)
  };
}

// Команда потеряла несколько героев, а игрок был жив и далеко
function replayMissedFights(focus) {
  const team = replay.deaths.filter(row => row.ally === replaySame(focus, replay.viewer) && row.hero !== focus.hero_id);
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
        const place = mapZone(where.x, where.y).toLowerCase();
        moments.push({
          time: first.time,
          title: `Команда потеряла ${group.length} героев без ${getHeroName(focus.hero_id)}`,
          wrong: [`Драка шла здесь: ${first.zone.toLowerCase()}. Герой был далеко: ${place}.`],
          fix: ['Чаще смотреть на карту: когда союзники собираются, идти к ним. Если не успеть, давить другую линию.'],
          cost: `Умерли: ${group.map(row => getHeroName(row.hero)).join(', ')}.`,
          near: { allies: [], enemies: [] },
          tone: 'bad',
          weight: 900,
          hero: focus.hero_id,
          category: 'team',
          headline: 'Команда дралась без тебя',
          text: `Умерли ${group.map(row => getHeroName(row.hero)).join(', ')}: ${first.zone.toLowerCase()}. Ты был далеко: ${place}.`,
          coach: 'Смотри на карту: когда союзники собираются, иди к ним. Если не успеваешь, дави другую линию.'
        });
      }
    }
    index += Math.max(1, group.length);
  }
  return moments;
}

// Первое убийство в выигранной драке: сила не только в том, чтобы не умирать
function replayGoodFights(focus) {
  const detail = playerDetail(replay.match, focus);
  if (!detail || !Array.isArray(detail.kills)) return [];
  const moments = [];
  let until = -Infinity;
  detail.kills.forEach(kill => {
    if (kill.time < until) return;
    const window = replay.deaths.filter(row => row.time >= kill.time - REPLAY_FIGHT_WINDOW / 2 && row.time <= kill.time + REPLAY_FIGHT_WINDOW);
    const enemies = window.filter(row => replayPlayer(row.hero) && !replaySame(replayPlayer(row.hero), focus));
    const allies = window.filter(row => replayPlayer(row.hero) && replaySame(replayPlayer(row.hero), focus));
    if (enemies.length < REPLAY_FIGHT_DEATHS - 1 || enemies.length <= allies.length) return;
    if (enemies.some(row => row.time < kill.time)) return;
    until = kill.time + REPLAY_FIGHT_WINDOW;
    moments.push({
      time: kill.time,
      title: `Первое убийство: ${getHeroName(kill.target)}`,
      wrong: [],
      fix: [],
      cost: '',
      near: { allies: [], enemies: [] },
      tone: 'good',
      weight: 800,
      hero: focus.hero_id,
      category: 'fight',
      headline: `Снял ${getHeroName(kill.target)} первым`,
      text: `Драка закончилась ${enemies.length}:${allies.length} в пользу твоей команды.`,
      coach: 'Первая цель решает драку. Так и продолжай: сначала тот, кто держит контроль или урон врага.'
    });
  });
  return moments.slice(0, REPLAY_GOOD_MAX);
}

// Рядом с Рошаном стояла одна команда: значит, забрала она
function replayRoshanMoments(focus) {
  if (!replay.heroes) return [];
  return replay.roshan.deaths.map(([time]) => {
    const spot = replayRoshanSpot(time);
    if (!spot) return null;
    const close = replay.match.players.filter(player => {
      const cell = replayPosition(replay.heroes[player.hero_id], time);
      return cell && !replayIsDead(replay.deaths, player.hero_id, time) && Math.hypot(cell.x - spot.x, cell.y - spot.y) <= REPLAY_ROSHAN_CELLS;
    });
    const ours = close.filter(player => replaySame(player, focus));
    const theirs = close.filter(player => !replaySame(player, focus));
    if (ours.length === theirs.length) return null;
    const won = ours.length > theirs.length;
    const here = ours.includes(focus);
    return {
      time,
      title: won ? 'Рошан у твоей команды' : 'Рошан у врага',
      wrong: [],
      fix: [],
      cost: '',
      near: { allies: [], enemies: [] },
      tone: won ? 'good' : 'bad',
      weight: 850,
      hero: focus.hero_id,
      point: mapPoint(spot.x, spot.y),
      category: 'team',
      headline: won ? 'Команда забрала Рошана' : 'Враг забрал Рошана',
      text: won ? `Рядом были: ${replayNames(ours)}.` : `Рядом были: ${replayNames(theirs)}. ${here ? 'Твоей команде не хватило людей.' : 'Тебя там не было.'}`,
      coach: won ? 'Теперь есть время: с Aegis идите на вышки, пока враг возрождается.' : 'Когда враги пропадают с карты, проверь логово: вард рядом с Рошаном покажет заход заранее.'
    };
  }).filter(Boolean);
}

function buildReplayMoments(focus) {
  if (!replay.heroes) return [];
  const deaths = replay.deaths.filter(row => row.hero === focus.hero_id).map(row => replayDeathMoment(row, focus));
  const all = [...deaths, ...replayMissedFights(focus), ...replayGoodFights(focus), ...replayRoshanMoments(focus)];
  return all.sort((a, b) => b.weight - a.weight).slice(0, REPLAY_MOMENTS_MAX).sort((a, b) => a.time - b.time);
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

// ─── Лента моментов ─────────────────────────────────────────────────────

function replayMomentHtml(moment, index) {
  return `
    <article class="rm-item ${moment.tone}" data-index="${index}" onclick="replayOpenMoment(${index})">
      <div class="rm-time"><strong>${esc(formatClock(moment.time))}</strong><span>${esc(REPLAY_CATEGORIES[moment.category])}</span></div>
      <div class="rm-body">
        <h4>${esc(moment.headline)}</h4>
        <p>${esc(moment.text)}</p>
        <p class="rm-coach"><b>Коуч:</b> ${esc(moment.coach)}</p>
      </div>
    </article>`;
}

function replayShowMoment(index) {
  const moment = replay.moments[index];
  replay.open = moment ? index : null;
  document.querySelectorAll('.rm-item').forEach(item => item.classList.toggle('active', Number(item.dataset.index) === index));
  if (moment) {
    const item = document.querySelector(`.rm-item[data-index="${index}"]`);
    replay.feedLock = performance.now() + 900;
    if (item && replay.playing === false && document.documentElement.scrollHeight > innerHeight && item.getBoundingClientRect().top > innerHeight) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  replayDraw();
}

// Метки рядом сливаются: вместо них показываем одну с числом
function replayClusters(items) {
  const clusters = [];
  items.forEach(item => {
    const last = clusters[clusters.length - 1];
    if (last && item.left - last.left < REPLAY_CLUSTER_SHARE) last.items.push(item);
    else clusters.push({ left: item.left, items: [item] });
  });
  return clusters;
}

function replayTimelineMarks() {
  const span = Math.max(1, replay.end - replay.start);
  const left = time => ((time - replay.start) / span) * 100;
  const top = replayClusters(replay.moments.map((moment, index) => ({ left: left(moment.time), index })));
  document.getElementById('rm-top').innerHTML = top.map(cluster => (cluster.items.length > 1
    ? `<button type="button" class="rm-count" style="left:${cluster.left}%" onclick="replayOpenMoment(${cluster.items[0].index})" aria-label="Моменты: ${cluster.items.length}">${cluster.items.length}</button>`
    : `<button type="button" class="rm-diamond" style="left:${cluster.left}%" onclick="replayOpenMoment(${cluster.items[0].index})" aria-label="Момент ${esc(formatClock(replay.moments[cluster.items[0].index].time))}"></button>`)).join('');

  const focus = replayPlayer(replay.focus);
  const deaths = replay.deaths.filter(row => row.hero === focus.hero_id)
    .map(row => `<i class="rm-x" style="left:${left(row.time)}%">×</i>`);
  const buildings = replay.buildings.filter(building => building.died != null && building.type !== 'OUTPOST')
    .map(building => `<i class="rm-square ${building.radiant === (replay.viewer.player_slot < 128) ? 'ally' : 'enemy'}" style="left:${left(building.died)}%"></i>`);
  document.getElementById('rm-bottom').innerHTML = [...deaths, ...buildings].join('');
}

function replayWatchFeed() {
  if (replay.observer) replay.observer.disconnect();
  if (!('IntersectionObserver' in window)) return;
  replay.observer = new IntersectionObserver(entries => {
    if (replay.playing || performance.now() < replay.feedLock) return;
    const seen = entries.find(entry => entry.isIntersecting);
    if (!seen) return;
    const index = Number(seen.target.dataset.index);
    if (index === replay.open) return;
    replay.time = replay.moments[index].time;
    replay.passed = replay.time;
    replayShowMoment(index);
  }, { rootMargin: '-45% 0px -45% 0px' });
  document.querySelectorAll('.rm-item').forEach(item => replay.observer.observe(item));
}

function replayRefreshMoments() {
  replay.moments = buildReplayMoments(replayPlayer(replay.focus));
  replay.open = null;
  document.getElementById('rm-feed').innerHTML = replay.moments.map(replayMomentHtml).join('')
    || '<p class="text-sm text-slate-400">У этого игрока нет смертей и пропущенных драк.</p>';
  replayTimelineMarks();
  replayWatchFeed();
}

function replaySetFocus(heroId) {
  replayStop();
  replay.focus = Number(heroId);
  replay.passed = replay.time;
  replayRefreshPins();
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
  replay.feedLock = performance.now() + 900;
  replayShowMoment(index);
}

function replayContinue() {
  replayShowMoment(-1);
  replayToggle();
}

function replayMomentInStep(from, to) {
  return replay.moments.findIndex(moment => moment.time > from && moment.time <= to && moment.time > (replay.passed ?? -Infinity));
}

// ─── Экран разбора ──────────────────────────────────────────────────────

function replayPinHtml(player) {
  const half = REPLAY_PIN / 2;
  return `
    <g id="replay-hero-${player.hero_id}" class="replay-hero">
      <title>${esc(getHeroName(player.hero_id))}</title>
      <circle class="rm-ring" r="${half + 0.5}" fill="#0A0B10" stroke-width=".7"/>
      <image href="${getHeroIcon(player.hero_id)}" x="${-half}" y="${-half}" width="${REPLAY_PIN}" height="${REPLAY_PIN}" preserveAspectRatio="xMidYMid slice" clip-path="url(#replay-pin)"/>
      <rect class="rm-hp-back" x="${-half}" y="${half + 1}" width="${REPLAY_PIN}" height=".9" rx=".3" fill="#05070A"/>
      <rect class="rm-hp" x="${-half}" y="${half + 1}" width="${REPLAY_PIN}" height=".9" rx=".3"/>
      <path class="rm-dead" d="M-2 -2 l4 4 m0 -4 l-4 4" stroke="#FDE047" stroke-width=".9" stroke-linecap="round"/>
    </g>`;
}

function replayRefreshPins() {
  replay.match.players.forEach(player => {
    const pin = document.getElementById(`replay-hero-${player.hero_id}`);
    if (!pin) return;
    const ally = replaySame(player, replay.viewer);
    const color = player.hero_id === replay.focus ? '#FDE047' : ally ? '#34D399' : '#F87171';
    pin.querySelector('.rm-ring').setAttribute('stroke', color);
    pin.querySelector('.rm-hp').setAttribute('fill', ally ? '#34D399' : '#F87171');
  });
}

function renderReplayShell() {
  const box = document.getElementById('rp-replay-stage');
  box.innerHTML = `
    <div class="rm-grid">
      <div class="rm-stage">
        <div class="rm-map">
          <svg class="death-map" viewBox="0 0 100 100" role="img" aria-label="Карта матча">
            ${mapBackground('replay', true)}
            <g id="rm-lairs">${MAP_ROSHAN_LAIRS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="none" stroke="#FDE047" stroke-opacity=".55" stroke-width=".3" stroke-dasharray=".9 .7"/>`).join('')}</g>
            <g id="rm-buildings"></g>
            <g id="rm-runes"></g>
            <g id="rm-couriers"></g>
            <g id="replay-wards"></g>
            <g id="rm-roshan"></g>
            <g id="replay-marks"></g>
            ${replay.match.players.map(replayPinHtml).join('')}
          </svg>
          <div id="rm-call" class="rm-call hidden" aria-live="polite"></div>
        </div>
        <div class="rm-bar">
          <button id="replay-play" type="button" class="rm-play" onclick="replayToggle()" aria-label="Смотреть">▶</button>
          <div class="rm-clock"><strong id="replay-clock"></strong><span>/ ${esc(formatClock(replay.end))}</span></div>
          <div class="rm-track">
            <div id="rm-top" class="rm-row"></div>
            <div class="rm-line"><i id="rm-fill"></i></div>
            <input id="replay-range" type="range" min="${replay.start}" max="${replay.end}" value="${replay.time}" aria-label="Время матча" oninput="replaySeek(Number(this.value))">
            <div id="rm-bottom" class="rm-row"></div>
          </div>
        </div>
      </div>
      <div class="rm-side">
        <div class="rm-tools">
          <select class="pro-input replay-focus" aria-label="Чей разбор показывать" onchange="replaySetFocus(this.value)">
            ${replay.match.players.map(player => `<option value="${player.hero_id}" ${player.hero_id === replay.focus ? 'selected' : ''}>${esc(getHeroName(player.hero_id))}${player === replay.viewer ? ' (ты)' : ''}</option>`).join('')}
          </select>
          ${REPLAY_SPEEDS.map(speed => `<button type="button" class="pro-pill plain ${speed === replay.speed ? 'active' : ''}" data-speed="${speed}" onclick="replaySpeed(${speed})">×${speed}</button>`).join('')}
          <label class="replay-check"><input type="checkbox" ${replay.pauseOnMistakes ? 'checked' : ''} onchange="replaySetPause(this.checked)"> Пауза на моментах</label>
        </div>
        <div id="rm-feed" class="rm-feed"></div>
        <p class="text-xs text-slate-400">Советы составлены по данным реплея. Туман войны и позиции примерные: точки идут раз в 5 секунд.</p>
      </div>
    </div>`;
  replay.drawnBuildings = '';
  replay.drawnWards = '';
  replayRefreshPins();
  replayRefreshMoments();
  replayDraw();
}

function replayRoshanSpot(time) {
  const spots = replay.roshan.spots;
  if (spots.length === 0) return null;
  let spot = spots[0];
  for (const entry of spots) {
    if (entry[0] > time) break;
    spot = entry;
  }
  return { x: spot[1], y: spot[2] };
}

function replayRoshanAlive(time) {
  return !replay.roshan.deaths.some(([from, to]) => time >= from && (to === null || time < to));
}

function replayDrawBuildings(time) {
  const key = replay.buildings.filter(building => building.died != null && building.died <= time).length;
  if (key === replay.drawnBuildings) return;
  replay.drawnBuildings = key;
  const viewerRadiant = replay.viewer.player_slot < 128;
  document.getElementById('rm-buildings').innerHTML = replay.buildings.map(building => {
    const { x, y } = mapPoint(building.x, building.y);
    const color = building.radiant === viewerRadiant ? '#34D399' : '#F87171';
    const gone = building.type !== 'OUTPOST' && building.died != null && building.died <= time;
    const style = gone ? 'fill="#0A0F0C" fill-opacity=".55" stroke="#55665C" stroke-opacity=".5"' : `fill="${color}" stroke="#06100B"`;
    if (building.type === 'FORT') return `<rect x="${(x - 1.7).toFixed(1)}" y="${(y - 1.7).toFixed(1)}" width="3.4" height="3.4" ${style} stroke-width=".3" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
    if (building.type === 'OUTPOST') return `<rect x="${(x - 1).toFixed(1)}" y="${(y - 1).toFixed(1)}" width="2" height="2" fill="#0B1411" stroke="${color}" stroke-width=".35" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
    const size = building.type === 'TOWER' ? 2 : 1.25;
    return `<rect x="${(x - size / 2).toFixed(1)}" y="${(y - size / 2).toFixed(1)}" width="${size}" height="${size}" rx=".28" ${style} stroke-width=".25"/>`;
  }).join('');
}

function replayDrawWards(time) {
  const visible = replay.wards.filter(ward => ward.time <= time && time < ward.end);
  const key = visible.map(ward => `${ward.time}:${ward.x}`).join();
  if (key === replay.drawnWards) return;
  replay.drawnWards = key;
  const viewerRadiant = replay.viewer.player_slot < 128;
  document.getElementById('replay-wards').innerHTML = visible.map(ward => wardIcon(ward, '', ward.radiant === viewerRadiant)).join('');
}

function replayDrawObjects(time) {
  const runes = replay.runes.filter(rune => rune.time <= time && time < rune.end).map(rune => {
    const { x, y } = mapPoint(rune.x, rune.y);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r=".85" fill="${rune.rune === 5 ? '#FDE047' : '#67E8F9'}" fill-opacity=".9" stroke="#06100B" stroke-width=".2"/>`;
  }).join('');
  document.getElementById('rm-runes').innerHTML = runes;

  const viewerRadiant = replay.viewer.player_slot < 128;
  document.getElementById('rm-couriers').innerHTML = replay.couriers.map(courier => {
    const spot = replayPosition(courier.points, time);
    if (!spot) return '';
    const { x, y } = mapPoint(spot.x, spot.y);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1" fill="#0B1411" fill-opacity=".85" stroke="${courier.radiant === viewerRadiant ? '#34D399' : '#F87171'}" stroke-opacity=".8" stroke-width=".25"/>`;
  }).join('');

  const spot = replayRoshanSpot(time);
  const roshan = spot && replayRoshanAlive(time) ? mapPoint(spot.x, spot.y) : null;
  document.getElementById('rm-roshan').innerHTML = roshan
    ? `<circle cx="${roshan.x.toFixed(1)}" cy="${roshan.y.toFixed(1)}" r="1.7" fill="#0B1411" stroke="#FDE047" stroke-width=".4"/><text x="${roshan.x.toFixed(1)}" y="${(roshan.y + 0.8).toFixed(1)}" text-anchor="middle" font-size="2.2" font-weight="700" fill="#FDE047">R</text>`
    : '';
}

// На паузе видно, кто стоял рядом с героем
function replayMomentLines(time) {
  const moment = replay.moments[replay.open];
  if (!moment || moment.tone === 'good') return '';
  const focus = replayPlayer(replay.focus);
  const from = replayPosition(replay.heroes[focus.hero_id], time);
  if (!from) return '';
  const start = mapPoint(from.x, from.y);
  const line = (player, color) => {
    const point = replayPosition(replay.heroes[player.hero_id], time);
    if (!point) return '';
    const end = mapPoint(point.x, point.y);
    return `<line x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" stroke="${color}" stroke-width=".35" stroke-dasharray="1.2 .9"/>`;
  };
  return `${moment.near.enemies.map(player => line(player, '#F87171')).join('')}${moment.near.allies.map(player => line(player, '#34D399')).join('')}`;
}

// Подпись момента лежит поверх карты: внутри SVG текст на телефоне был бы слишком мелким
function replayCallout(time) {
  const call = document.getElementById('rm-call');
  const moment = replay.moments[replay.open];
  const point = moment ? moment.point || replayMapPoint(replay.focus, time) : null;
  if (!moment || !point) {
    call.classList.add('hidden');
    return '';
  }
  const toRight = point.x < 55;
  const toBelow = point.y < 22;
  const end = { x: point.x + (toRight ? 7 : -7), y: point.y + (toBelow ? 7 : -7) };
  call.classList.remove('hidden');
  call.style.left = `${end.x}%`;
  call.style.top = `${end.y}%`;
  call.style.transform = `translate(${toRight ? '0' : '-100%'}, -50%)`;
  call.innerHTML = `<strong>${esc(formatClock(moment.time))}</strong><span>${esc(moment.headline)}</span>`;
  return `<line x1="${point.x.toFixed(1)}" y1="${point.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" stroke="#FDE047" stroke-width=".4"/>`;
}

function replayDraw() {
  const time = replay.time;
  const viewerSide = replay.viewer;
  replay.match.players.forEach(player => {
    const pin = document.getElementById(`replay-hero-${player.hero_id}`);
    if (!pin) return;
    const point = replayMapPoint(player.hero_id, time);
    if (!point) {
      pin.setAttribute('visibility', 'hidden');
      return;
    }
    const dead = replayIsDead(replay.deaths, player.hero_id, time);
    const hidden = !dead && !replaySame(player, viewerSide) && !replaySeesPoint(viewerSide, point, time);
    pin.setAttribute('transform', `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
    pin.setAttribute('opacity', dead ? '.3' : hidden ? '.5' : '1');
    pin.querySelector('.rm-dead').setAttribute('visibility', dead ? 'visible' : 'hidden');
    const hp = replayHealth(player.hero_id, time);
    pin.querySelector('.rm-hp').setAttribute('width', ((REPLAY_PIN * (dead ? 0 : hp ?? 100)) / 100).toFixed(2));
  });

  replayDrawBuildings(time);
  replayDrawWards(time);
  replayDrawObjects(time);

  const marks = replay.deaths
    .filter(row => row.time <= time && time - row.time <= REPLAY_MARK_SECONDS)
    .map(row => `<path d="M${(row.x - 1.6).toFixed(1)} ${(row.y - 1.6).toFixed(1)} l3.2 3.2 m0 -3.2 l-3.2 3.2" stroke="#FDE047" stroke-width=".7" stroke-linecap="round"/>`)
    .join('');
  document.getElementById('replay-marks').innerHTML = marks + replayMomentLines(time) + replayCallout(time);

  const span = Math.max(1, replay.end - replay.start);
  document.getElementById('replay-clock').textContent = formatClock(Math.round(time));
  document.getElementById('replay-range').value = Math.round(time);
  document.getElementById('rm-fill').style.width = `${((time - replay.start) / span) * 100}%`;
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
  if (button) {
    button.textContent = '▶';
    button.setAttribute('aria-label', 'Смотреть');
  }
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
  const button = document.getElementById('replay-play');
  button.textContent = '❚❚';
  button.setAttribute('aria-label', 'Пауза');
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
  const [data] = await Promise.all([proFetchJson(`/playback/${m.match_id}`), loadItemNames(), draftLoadTitles()]);
  if (token !== replay.token) return false;

  replay.match = live.match;
  replay.viewer = live.player;
  replay.heroes = data && data.heroes ? data.heroes : null;
  replay.wards = wardList(data && data.wards, live.match);
  replay.buildings = data && Array.isArray(data.buildings) ? data.buildings : [];
  replay.roshan = data && data.roshan ? data.roshan : { spots: [], deaths: [] };
  replay.runes = data && Array.isArray(data.runes) ? data.runes : [];
  replay.couriers = data && Array.isArray(data.couriers) ? data.couriers : [];
  replay.health = (data && data.health) || {};
  replay.loadouts = (data && data.loadouts) || {};
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
  status.textContent = 'Загружаю карту матча...';
  button.classList.add('hidden');
  const loaded = await replayFetch(m);
  if (!loaded) {
    status.textContent = 'Для этого матча пока нет данных карты. Такое бывает, пока STRATZ не разобрал реплей.';
    button.classList.remove('hidden');
    return false;
  }
  status.textContent = '';
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

// Данные тяжёлые, поэтому грузим, только когда карта появилась на экране
function replayWatchCard(m) {
  const card = document.getElementById('rp-replay');
  if (replay.watcher) replay.watcher.disconnect();
  if (!('IntersectionObserver' in window)) return;
  replay.watcher = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    replay.watcher.disconnect();
    if (currentActiveReplayMatch && currentActiveReplayMatch.match_id === m.match_id && !document.getElementById('replay-play')) replayLoad(m);
  }, { rootMargin: '200px' });
  replay.watcher.observe(card);
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
  if (live && live.match.details) replayWatchCard(m);
}
