'use strict';

// Карта матча: своя схема Dota 2 (не картинка из игры), герои в местах смертей и список «кто, где, когда».
// Координаты из STRATZ лежат в игровой сетке, а башни заданы мировыми координатами и переводятся в неё.

const MAP_MIN = 62; // игровая сетка STRATZ: герои ходят от 62 до 192
const MAP_SIZE = 130;
const MAP_RIVER_WIDTH = 7;
const MAP_LANE_EDGE = 22;
const MAP_MID_WIDTH = 10;
const MAP_BASE_RADIUS = 20;
const MAP_PHASES = [
  ['all', 'Вся игра', 0, Infinity],
  ['early', '0–10', 0, 600],
  ['mid', '10–20', 600, 1200],
  ['late', '20–30', 1200, 1800],
  ['end', '30+', 1800, Infinity]
];
const MAP_FILTERS = [
  ['me', 'Мои смерти'],
  ['kills', 'Мои убийства'],
  ['team', 'Моя команда'],
  ['enemy', 'Враги'],
  ['all', 'Все']
];
const MAP_TOWERS = {
  radiant: [[-6336, 1856], [-6288, -872], [-6592, -3408], [-1544, -1408], [-3190, -2926], [-4640, -4144], [4926, -6286], [-360, -6256], [-3952, -6112]],
  dire: [[-5275, 5928], [0, 6016], [3504, 5776], [524, 652], [2496, 2112], [4272, 3759], [6269, -1700], [6208, 384], [6336, 3032]]
};

const mapView = { who: 'me', phase: 'all', match: null, viewer: null, rows: [], focus: null };

function mapCell(value) {
  return Math.max(0, Math.min(100, ((value - MAP_MIN) / MAP_SIZE) * 100));
}

function mapPoint(cellX, cellY) {
  return { x: mapCell(cellX), y: 100 - mapCell(cellY) };
}

function mapWorld(worldX, worldY) {
  return mapPoint(worldX / 128 + 128, worldY / 128 + 128);
}

function deathPoints(deaths, flip) {
  return deaths
    .filter(death => death.positionX != null && death.positionY != null)
    .map(death => {
      const { x, y } = mapPoint(death.positionX, death.positionY);
      return { x: flip ? 100 - x : x, y: flip ? 100 - y : y, time: death.time };
    });
}

// Своя база внизу слева, поэтому чужая половина лежит выше главной диагонали
function enemyHalfShare(points) {
  return Math.round((points.filter(point => point.x > point.y).length / Math.max(1, points.length)) * 100);
}

// Названия примерные: граница линии и леса на схеме условная
function mapZone(x, y) {
  if (Math.hypot(x - 15, y - 85) < MAP_BASE_RADIUS) return 'База Сил Света';
  if (Math.hypot(x - 85, y - 15) < MAP_BASE_RADIUS) return 'База Сил Тьмы';
  if (Math.abs(x - y) < MAP_RIVER_WIDTH) return 'Река';
  if (x < MAP_LANE_EDGE || y < MAP_LANE_EDGE) return 'Верхняя линия';
  if (x > 100 - MAP_LANE_EDGE || y > 100 - MAP_LANE_EDGE) return 'Нижняя линия';
  if (Math.abs(x + y - 100) < MAP_MID_WIDTH) return 'Центр';
  return y > x ? 'Лес Сил Света' : 'Лес Сил Тьмы';
}

function mapTowers(list, color) {
  return list.map(([worldX, worldY]) => {
    const { x, y } = mapWorld(worldX, worldY);
    return `<rect x="${(x - 0.9).toFixed(1)}" y="${(y - 0.9).toFixed(1)}" width="1.8" height="1.8" rx=".3" fill="${color}" stroke="#0A0B10" stroke-width=".3"/>`;
  }).join('');
}

function mapBackground(id) {
  return `
    <defs>
      <linearGradient id="${id}-land" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="#1F4A33"/><stop offset=".46" stop-color="#26382F"/>
        <stop offset=".54" stop-color="#3A2B2B"/><stop offset="1" stop-color="#57241F"/>
      </linearGradient>
      <linearGradient id="${id}-river" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2B7FA8"/><stop offset="1" stop-color="#2D5FA0"/>
      </linearGradient>
      <radialGradient id="${id}-good"><stop offset="0" stop-color="#6EE7B7"/><stop offset="1" stop-color="#6EE7B7" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}-bad"><stop offset="0" stop-color="#FCA5A5"/><stop offset="1" stop-color="#FCA5A5" stop-opacity="0"/></radialGradient>
      <clipPath id="${id}-pin" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath>
    </defs>
    <rect width="100" height="100" rx="3" fill="url(#${id}-land)"/>
    <g fill="#12261B" fill-opacity=".55">
      <ellipse cx="30" cy="66" rx="13" ry="8" transform="rotate(-20 30 66)"/><ellipse cx="60" cy="74" rx="14" ry="6"/>
      <ellipse cx="24" cy="44" rx="7" ry="11"/>
    </g>
    <g fill="#2A1212" fill-opacity=".55">
      <ellipse cx="70" cy="34" rx="13" ry="8" transform="rotate(-20 70 34)"/><ellipse cx="40" cy="26" rx="14" ry="6"/>
      <ellipse cx="76" cy="56" rx="7" ry="11"/>
    </g>
    <path d="M-2 4 C 16 12, 26 26, 36 34 S 62 62, 70 70 S 88 90, 102 98" fill="none" stroke="url(#${id}-river)" stroke-width="6" stroke-linecap="round" stroke-opacity=".9"/>
    <g fill="none" stroke="#C9B48A" stroke-opacity=".5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 84 L13 16 L16 13 L84 13"/>
      <path d="M16 86 L84 87 L87 84 L87 16"/>
      <path d="M19 81 L81 19"/>
    </g>
    ${mapTowers(MAP_TOWERS.radiant, '#6EE7B7')}${mapTowers(MAP_TOWERS.dire, '#FCA5A5')}
    <circle cx="15" cy="85" r="11" fill="url(#${id}-good)" fill-opacity=".55"/>
    <circle cx="85" cy="15" r="11" fill="url(#${id}-bad)" fill-opacity=".55"/>
    <rect x="13" y="83" width="4" height="4" rx=".8" fill="#34D399" stroke="#0A0B10" stroke-width=".4"/>
    <rect x="83" y="13" width="4" height="4" rx=".8" fill="#F87171" stroke="#0A0B10" stroke-width=".4"/>
    <text x="22" y="97" class="map-label">Силы Света</text>
    <text x="78" y="5" class="map-label" text-anchor="end">Силы Тьмы</text>`;
}

// Карта с точками: для сводки по всем матчам
function deathMapHtml(points, label) {
  return `
    <svg class="death-map" viewBox="0 0 100 100" role="img" aria-label="${esc(label)}">
      ${mapBackground('sum')}
      ${points.map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="1.5" fill="#FFB4B4" fill-opacity=".8" stroke="#7F1D1D" stroke-width=".3">${point.time != null ? `<title>${esc(formatClock(point.time))}</title>` : ''}</circle>`).join('')}
    </svg>`;
}

// ─── Смерти матча ───────────────────────────────────────────────────────

function matchDeaths(match, viewer) {
  const viewerRadiant = viewer.player_slot < 128;
  const rows = [];
  match.players.forEach(player => {
    const detail = playerDetail(match, player);
    if (!detail) return;
    const isRadiant = player.player_slot < 128;
    deathPoints(detail.deaths, false).forEach((point, index) => {
      const source = detail.deaths.filter(death => death.positionX != null && death.positionY != null)[index];
      rows.push({
        ...point,
        hero: player.hero_id,
        killer: HEROES_DB[source.attacker] ? source.attacker : null,
        ally: isRadiant === viewerRadiant,
        mine: player === viewer,
        zone: mapZone(point.x, point.y),
        goldLost: source.goldLost || 0,
        goldFed: source.goldFed || 0,
        timeDead: source.timeDead || 0,
        reasons: deathReasons(source)
      });
    });
  });
  return rows.sort((a, b) => a.time - b.time);
}

function mapFiltered(rows, viewer, who, phase) {
  const [, , from, to] = MAP_PHASES.find(item => item[0] === phase);
  return rows.filter(row => {
    if (row.time < from || row.time >= to) return false;
    if (who === 'me') return row.mine;
    if (who === 'kills') return row.killer === viewer.hero_id;
    if (who === 'team') return row.ally;
    return who === 'enemy' ? !row.ally : true;
  });
}

function mapMostCommon(values) {
  const counts = new Map();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
}

function mapSummary(rows, who) {
  if (rows.length === 0) return '';
  const zone = mapMostCommon(rows.map(row => row.zone));
  const parts = [`Всего: ${rows.length}`];
  if (who === 'kills') {
    const victim = mapMostCommon(rows.map(row => row.hero));
    parts.push(`чаще всего ${getHeroName(victim[0])} (${victim[1]})`);
  } else {
    const killer = mapMostCommon(rows.map(row => row.killer).filter(Boolean));
    if (killer) parts.push(`чаще всего убивал ${getHeroName(killer[0])} (${killer[1]})`);
  }
  parts.push(`больше всего здесь: ${zone[0].toLowerCase()} (${zone[1]})`);
  if (who === 'me') {
    parts.push(`потеряно ${rows.reduce((sum, row) => sum + row.goldLost, 0).toLocaleString()} золота`);
    parts.push(`на респауне ${rows.reduce((sum, row) => sum + row.timeDead, 0)} секунд`);
  }
  return `${parts.join(', ')}.`;
}

function mapPin(row, index) {
  const size = 7.4;
  const color = row.ally ? '#F45D66' : '#60A5FA';
  return `
    <g class="map-pin" data-pin="${index}" onclick="mapFocus(${index})">
      <title>${esc(`${formatClock(row.time)}: ${getHeroName(row.hero)}${row.killer ? `, убил ${getHeroName(row.killer)}` : ''}, ${row.zone}`)}</title>
      <circle class="map-ring" cx="${row.x.toFixed(1)}" cy="${row.y.toFixed(1)}" r="${(size / 2 + 0.5).toFixed(1)}" fill="#0A0B10" stroke="${color}" stroke-width=".9"/>
      <image href="${getHeroIcon(row.hero)}" x="${(row.x - size / 2).toFixed(1)}" y="${(row.y - size / 2).toFixed(1)}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#match-pin)"/>
      <circle cx="${(row.x + 3).toFixed(1)}" cy="${(row.y + 3).toFixed(1)}" r="1.9" fill="#0A0B10" stroke="${color}" stroke-width=".35"/>
      <text x="${(row.x + 3).toFixed(1)}" y="${(row.y + 3.75).toFixed(1)}" class="map-num" text-anchor="middle">${index + 1}</text>
    </g>`;
}

function mapRowHtml(row, index) {
  const cost = [];
  if (row.goldLost) cost.push(`−${row.goldLost.toLocaleString()} золота`);
  if (row.goldFed) cost.push(`враг +${row.goldFed.toLocaleString()}`);
  if (row.timeDead) cost.push(`респаун ${row.timeDead} сек.`);
  const hero = id => `<span class="map-hero"><img loading="lazy" decoding="async" src="${getHeroIcon(id)}" alt="">${esc(getHeroName(id))}</span>`;
  return `
    <button type="button" class="map-row" data-row="${index}" onclick="mapFocus(${index})" onmouseenter="mapFocus(${index}, true)">
      <span class="map-index">${index + 1}</span>
      <span class="map-body">
        <span class="map-top"><strong>${esc(formatClock(row.time))}</strong>${hero(row.hero)}${row.killer ? `<small>убил</small>${hero(row.killer)}` : '<small>крипы или башня</small>'}</span>
        <span class="map-where">${esc(row.zone)}</span>
        ${cost.length > 0 ? `<span class="map-cost">${esc(cost.join(' · '))}</span>` : ''}
        ${row.reasons.length > 0 ? `<span class="map-why">${esc(row.reasons.join(', '))}</span>` : ''}
      </span>
    </button>`;
}

function mapButtons(items, active, action) {
  return items.map(([key, label]) => `<button type="button" class="pro-pill plain ${key === active ? 'active' : ''}" onclick="${action}('${key}')">${esc(label)}</button>`).join('');
}

function renderDeathView() {
  const box = document.getElementById('rp-death-map');
  const rows = mapFiltered(mapView.rows, mapView.viewer, mapView.who, mapView.phase);
  mapView.shown = rows;
  mapView.focus = null;
  const empty = mapView.who === 'me' ? 'Твоих смертей здесь нет.' : 'Здесь событий нет.';
  box.innerHTML = `
    <div class="flex flex-wrap gap-2">${mapButtons(MAP_FILTERS, mapView.who, 'mapSetWho')}</div>
    <div class="flex flex-wrap gap-2">${mapButtons(MAP_PHASES, mapView.phase, 'mapSetPhase')}</div>
    <p class="text-sm text-slate-300">${esc(mapSummary(rows, mapView.who) || empty)}</p>
    <div class="map-wrap">
      <svg class="death-map" viewBox="0 0 100 100" role="img" aria-label="Карта смертей в матче">
        ${mapBackground('match')}
        ${rows.map(mapPin).join('')}
      </svg>
      <div class="map-list" aria-live="polite">${rows.map(mapRowHtml).join('')}</div>
    </div>
    <p class="text-xs text-slate-400">Схема карты, названия мест примерные. Красная рамка: твоя команда, синяя: враги.</p>`;
}

function mapSetWho(who) {
  mapView.who = who;
  renderDeathView();
}

function mapSetPhase(phase) {
  mapView.phase = phase;
  renderDeathView();
}

// Выбранный герой выносится наверх, иначе соседние значки его закрывают
function mapFocus(index, fromHover = false) {
  if (mapView.focus === index) return;
  mapView.focus = index;
  const box = document.getElementById('rp-death-map');
  box.querySelectorAll('.map-pin.active, .map-row.active').forEach(item => item.classList.remove('active'));
  const pin = box.querySelector(`[data-pin="${index}"]`);
  const row = box.querySelector(`[data-row="${index}"]`);
  if (pin) {
    pin.classList.add('active');
    pin.parentNode.appendChild(pin);
  }
  if (row) {
    row.classList.add('active');
    if (!fromHover) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderMatchDeathMap(m) {
  const box = document.getElementById('rp-death-map');
  const timeline = document.getElementById('death-timeline');
  if (!box) return;
  const live = getLiveMatchData(m);
  const rows = live ? matchDeaths(live.match, live.player) : [];
  box.classList.toggle('hidden', rows.length === 0);
  if (timeline) timeline.classList.toggle('hidden', rows.length > 0);
  if (rows.length === 0) {
    box.innerHTML = '';
    mapView.rows = [];
    return;
  }
  const changed = mapView.match !== live.match;
  mapView.match = live.match;
  mapView.viewer = live.player;
  mapView.rows = rows;
  if (changed) {
    mapView.who = 'me';
    mapView.phase = 'all';
  }
  renderDeathView();
}
