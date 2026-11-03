'use strict';

// 2D-повтор: настоящие позиции героев из реплея (STRATZ) на нашей схеме карты.
// Это не видео из игры: видео может сделать только клиент Dota, а здесь точки каждые 5 секунд.

const REPLAY_SPEEDS = [8, 16, 32];
const REPLAY_MARK_SECONDS = 10;
const REPLAY_FEED_ITEMS = 4;

const replay = {
  match: null,
  viewer: null,
  heroes: null,
  deaths: [],
  time: 0,
  end: 0,
  speed: 16,
  playing: false,
  frame: null,
  last: 0,
  matchId: null,
  token: 0
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
        <g id="replay-marks"></g>
        ${pins}
      </svg>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <button id="replay-play" type="button" class="pro-btn" onclick="replayToggle()">Смотреть</button>
          ${REPLAY_SPEEDS.map(speed => `<button type="button" class="pro-pill plain ${speed === replay.speed ? 'active' : ''}" data-speed="${speed}" onclick="replaySpeed(${speed})">×${speed}</button>`).join('')}
          <strong id="replay-clock" class="text-white"></strong>
        </div>
        <input id="replay-range" type="range" class="w-full" min="${replay.start}" max="${replay.end}" value="${replay.time}" aria-label="Время матча" oninput="replaySeek(Number(this.value))">
        <div id="replay-feed" class="space-y-1" aria-live="off"></div>
        <p class="text-xs text-slate-400">Белая рамка: ты, зелёная: союзники, красная: враги. Герой тускнеет, пока мёртв, крестик показывает место смерти.</p>
      </div>
    </div>`;
  replayDraw();
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

  document.getElementById('replay-marks').innerHTML = replay.deaths
    .filter(row => row.time <= time && time - row.time <= REPLAY_MARK_SECONDS)
    .map(row => `<path d="M${(row.x - 2).toFixed(1)} ${(row.y - 2).toFixed(1)} l4 4 m0 -4 l-4 4" stroke="#FDE047" stroke-width="1" stroke-linecap="round"/>`)
    .join('');

  document.getElementById('replay-clock').textContent = formatClock(Math.round(time));
  document.getElementById('replay-range').value = Math.round(time);
  document.getElementById('replay-feed').innerHTML = replayFeed(replay.deaths, time).map(row => `
    <p class="text-xs text-slate-300"><strong class="text-white">${esc(formatClock(row.time))}</strong> ${esc(getHeroName(row.hero))}${row.killer ? `, убил ${esc(getHeroName(row.killer))}` : ''}, ${esc(row.zone.toLowerCase())}</p>`).join('');
}

function replayTick(now) {
  if (!replay.playing) return;
  const seconds = (now - replay.last) / 1000;
  replay.last = now;
  replay.time = Math.min(replay.end, replay.time + seconds * replay.speed);
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
  if (replay.time >= replay.end) replay.time = replay.start;
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
  replayDraw();
}

async function replayLoad(m) {
  const live = getLiveMatchData(m);
  if (!live) return false;
  const token = ++replay.token;
  const status = document.getElementById('rp-replay-status');
  status.textContent = 'Загружаю позиции героев...';
  document.getElementById('rp-replay-load').disabled = true;

  const data = await proFetchJson(`/playback/${m.match_id}`);
  if (token !== replay.token) return false;
  document.getElementById('rp-replay-load').disabled = false;

  replay.match = live.match;
  replay.viewer = live.player;
  replay.heroes = data && data.heroes ? data.heroes : null;
  replay.deaths = matchDeaths(live.match, live.player);
  replay.matchId = m.match_id;
  replay.start = 0;
  replay.end = live.match.duration || 0;
  replay.time = 0;

  if (!replay.heroes) {
    status.textContent = 'Для этого матча нет позиций героев. Такое бывает, пока STRATZ не разобрал реплей.';
    return false;
  }
  status.textContent = '';
  document.getElementById('rp-replay-load').classList.add('hidden');
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
  if (replay.matchId !== m.match_id || !replay.heroes) {
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
  const hasDetails = !!(live && live.match.details);
  card.classList.toggle('hidden', !hasDetails);
  if (replay.matchId === m.match_id) return;

  replayStop();
  replay.token += 1;
  replay.matchId = null;
  replay.heroes = null;
  document.getElementById('rp-replay-stage').innerHTML = '';
  document.getElementById('rp-replay-status').textContent = '';
  const button = document.getElementById('rp-replay-load');
  button.classList.remove('hidden');
  button.disabled = false;
}
