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
  ['all', 'Все'],
  ['wards', 'Варды']
];
const MAP_TOWERS = {
  radiant: [[-6336, 1856], [-6288, -872], [-6592, -3408], [-1544, -1408], [-3190, -2926], [-4640, -4144], [4926, -6286], [-360, -6256], [-3952, -6112]],
  dire: [[-5275, 5928], [0, 6016], [3504, 5776], [524, 652], [2496, 2112], [4272, 3759], [6269, -1700], [6208, 384], [6336, 3032]]
};

const mapView = { who: 'me', phase: 'all', match: null, viewer: null, rows: [], shown: [], focus: null, wards: [], token: 0 };

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

// Рисуем местность один раз на холсте: тысячи деревьев внутри SVG тормозили бы повтор
const MAP_TEXTURE_SIZE = 900;
const MAP_LANES = [
  [[14, 84], [13, 16], [16, 13], [84, 13]],
  [[16, 86], [84, 87], [87, 84], [87, 16]],
  [[19, 81], [81, 19]]
];
const MAP_FORESTS = [[22, 40, 9], [24, 62, 10], [36, 73, 8], [56, 75, 10], [71, 75, 7], [35, 50, 6], [48, 63, 5], [8, 50, 5], [50, 93, 5]];
let mapTextureUrl = null;

function mapRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function mapSegmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const share = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * share), py - (ay + dy * share));
}

function mapNearLane(x, y, distance) {
  return MAP_LANES.some(lane => lane.slice(1).some((point, index) => mapSegmentDistance(x, y, lane[index], point) < distance));
}

function mapStroke(ctx, draw, color, width) {
  ctx.beginPath();
  draw();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function mapDrawTrees(ctx, random) {
  const forests = [...MAP_FORESTS, ...MAP_FORESTS.map(([x, y, r]) => [100 - x, 100 - y, r])];
  for (let i = 0; i < 3400; i++) {
    const x = random() * 100;
    const y = random() * 100;
    const edge = x < 5 || y < 5 || x > 95 || y > 95;
    const inForest = forests.some(([fx, fy, r]) => Math.hypot(x - fx, y - fy) < r * (0.7 + random() * 0.4));
    if (!edge && !inForest) continue;
    if (Math.abs(x - y) < 8 || mapNearLane(x, y, 4) || Math.hypot(x - 12, y - 88) < 17 || Math.hypot(x - 88, y - 12) < 17) continue;

    const radiant = y > x;
    const size = 0.65 + random() * 0.6;
    ctx.fillStyle = 'rgba(0, 0, 0, .35)';
    ctx.beginPath();
    ctx.arc(x + 0.25, y + 0.3, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = radiant ? `hsl(${138 + random() * 22}, 38%, ${16 + random() * 10}%)` : `hsl(${8 + random() * 22}, 34%, ${16 + random() * 9}%)`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = radiant ? 'rgba(150, 220, 150, .16)' : 'rgba(240, 170, 120, .13)';
    ctx.beginPath();
    ctx.arc(x - size * 0.25, y - size * 0.3, size * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
}

function mapDrawTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_TEXTURE_SIZE;
  canvas.height = MAP_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(MAP_TEXTURE_SIZE / 100, MAP_TEXTURE_SIZE / 100);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const random = mapRandom(20261103);

  const land = ctx.createLinearGradient(0, 100, 100, 0);
  land.addColorStop(0, '#2C5F3B');
  land.addColorStop(0.45, '#2E4A36');
  land.addColorStop(0.55, '#4A3A30');
  land.addColorStop(1, '#6B2F27');
  ctx.fillStyle = land;
  ctx.fillRect(0, 0, 100, 100);

  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = random() > 0.5 ? 'rgba(255, 255, 255, .025)' : 'rgba(0, 0, 0, .05)';
    ctx.fillRect(random() * 100, random() * 100, 0.35, 0.35);
  }

  [[12, 88, 'rgba(120, 200, 150, .28)'], [88, 12, 'rgba(230, 120, 100, .26)']].forEach(([x, y, color]) => {
    const glow = ctx.createRadialGradient(x, y, 2, x, y, 24);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 100, 100);
  });

  const river = () => {
    ctx.moveTo(-2, 3);
    ctx.bezierCurveTo(16, 12, 26, 26, 36, 34);
    ctx.bezierCurveTo(46, 42, 54, 56, 66, 66);
    ctx.bezierCurveTo(76, 74, 88, 90, 102, 98);
  };
  mapStroke(ctx, river, 'rgba(10, 18, 16, .65)', 7.6);
  const water = ctx.createLinearGradient(0, 0, 100, 100);
  water.addColorStop(0, '#2E8FB8');
  water.addColorStop(0.5, '#2A7FB0');
  water.addColorStop(1, '#2F68AE');
  mapStroke(ctx, river, water, 6);
  ctx.setLineDash([3, 5]);
  mapStroke(ctx, river, 'rgba(190, 235, 255, .22)', 0.5);
  ctx.setLineDash([]);

  const road = lane => () => {
    lane.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  };
  MAP_LANES.forEach(lane => mapStroke(ctx, road(lane), 'rgba(30, 22, 12, .55)', 2.9));
  MAP_LANES.forEach(lane => mapStroke(ctx, road(lane), '#B79E70', 2));
  MAP_LANES.forEach(lane => mapStroke(ctx, road(lane), 'rgba(240, 225, 180, .28)', 0.7));

  mapDrawTrees(ctx, random);
  return canvas.toDataURL('image/jpeg', 0.86);
}

function mapTexture() {
  if (mapTextureUrl === null) {
    try {
      mapTextureUrl = mapDrawTexture();
    } catch (e) {
      mapTextureUrl = '';
    }
  }
  return mapTextureUrl;
}

function mapBackground(id) {
  const texture = mapTexture();
  return `
    <defs>
      <radialGradient id="${id}-good"><stop offset="0" stop-color="#6EE7B7"/><stop offset="1" stop-color="#6EE7B7" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}-bad"><stop offset="0" stop-color="#FCA5A5"/><stop offset="1" stop-color="#FCA5A5" stop-opacity="0"/></radialGradient>
      <clipPath id="${id}-pin" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath>
    </defs>
    <rect width="100" height="100" fill="#2E4A36"/>
    ${texture ? `<image href="${texture}" width="100" height="100"/>` : ''}
    ${mapTowers(MAP_TOWERS.radiant, '#6EE7B7')}${mapTowers(MAP_TOWERS.dire, '#FCA5A5')}
    <circle cx="15" cy="85" r="10" fill="url(#${id}-good)" fill-opacity=".6"/>
    <circle cx="85" cy="15" r="10" fill="url(#${id}-bad)" fill-opacity=".6"/>
    <rect x="12.8" y="82.8" width="4.4" height="4.4" rx=".9" fill="#34D399" stroke="#06170F" stroke-width=".5"/>
    <rect x="82.8" y="12.8" width="4.4" height="4.4" rx=".9" fill="#F87171" stroke="#1A0606" stroke-width=".5"/>
    <text x="24" y="97" class="map-label">Силы Света</text>
    <text x="76" y="5" class="map-label" text-anchor="end">Силы Тьмы</text>`;
}

// ─── Варды ──────────────────────────────────────────────────────────────

const WARD_LIFE = { OBSERVER: 360, SENTRY: 420 };
const WARD_NAMES = { OBSERVER: 'Обзорный вард', SENTRY: 'Сентри' };
const WARD_VISION = 9.6;
const WARD_LATE_SECONDS = 900;

// STRATZ присылает появление и исчезновение варда отдельными событиями с одним номером
function wardList(events, match) {
  if (!Array.isArray(events)) return [];
  const open = new Map();
  const wards = [];
  [...events].sort((a, b) => a.time - b.time).forEach(event => {
    if (event.action === 'SPAWN') {
      const player = match.players.find(p => p.player_slot === event.fromPlayer);
      const { x, y } = mapPoint(event.positionX, event.positionY);
      const life = WARD_LIFE[event.wardType] || WARD_LIFE.OBSERVER;
      const ward = {
        time: event.time,
        end: event.time + life,
        life,
        x,
        y,
        type: event.wardType,
        hero: player ? player.hero_id : null,
        radiant: event.fromPlayer < 128,
        zone: mapZone(x, y),
        destroyed: false
      };
      open.set(event.indexId, ward);
      wards.push(ward);
    } else if (event.action === 'DESPAWN' && open.has(event.indexId)) {
      const ward = open.get(event.indexId);
      open.delete(event.indexId);
      ward.destroyed = event.time < ward.time + ward.life - 15;
      ward.end = Math.min(ward.end, event.time);
    }
  });
  return wards;
}

function wardIcon(ward, extra = '') {
  const color = ward.type === 'SENTRY' ? '#60A5FA' : '#FDE047';
  const edge = ward.radiant ? '#34D399' : '#F87171';
  const { x, y } = ward;
  const vision = ward.type === 'SENTRY' ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${WARD_VISION}" fill="${color}" fill-opacity=".07" stroke="${color}" stroke-opacity=".28" stroke-width=".25"/>`;
  return `${vision}<path ${extra} d="M${x.toFixed(1)} ${(y - 2.1).toFixed(1)} l2.1 2.1 l-2.1 2.1 l-2.1 -2.1 z" fill="${color}" stroke="${edge}" stroke-width=".55"/>`;
}

function wardMoment(ward, viewer) {
  const lived = ward.end - ward.time;
  const wrong = [];
  const fix = [];
  const ownHalf = ward.radiant ? ward.y > ward.x + MAP_RIVER_WIDTH : ward.x > ward.y + MAP_RIVER_WIDTH;
  if (ward.destroyed && lived < ward.life * 0.6) {
    wrong.push(`Вард снесли через ${formatClock(lived)}.`);
    fix.push('Менять точки: враг уже проверяет это место сентри. Ставить туда, куда он не ходит.');
  }
  if (ownHalf && ward.time >= WARD_LATE_SECONDS && ward.type === 'OBSERVER') {
    wrong.push('После 15 минуты вард стоит на своей половине.');
    fix.push('Ставить ближе к реке или в лес врага, чтобы видеть его заранее.');
  }
  const owner = ward.hero ? getHeroName(ward.hero) : 'Игрок';
  const side = ward.radiant === (viewer.player_slot < 128) ? 'твоя команда' : 'враг';
  return {
    time: ward.time,
    title: `${WARD_NAMES[ward.type] || 'Вард'}: ${owner}, ${ward.zone.toLowerCase()}`,
    wrong: wrong.length > 0 ? wrong : [ward.destroyed ? `Вард снесли через ${formatClock(lived)}, он успел поработать.` : 'Ошибки нет: вард простоял до конца.'],
    fix: fix.length > 0 ? fix : ['Это место можно использовать снова.'],
    cost: `Поставил: ${side}. Простоял ${formatClock(lived)} из ${formatClock(ward.life)}.`
  };
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
        raw: source,
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
      <title>${esc(`${formatClock(row.time)}: ${row.killer ? `${getHeroName(row.killer)} убил ${getHeroName(row.hero)}` : `умер ${getHeroName(row.hero)}`}, ${row.zone}`)}</title>
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
        <span class="map-top"><strong>${esc(formatClock(row.time))}</strong>${row.killer ? `${hero(row.killer)}<small>убил</small>${hero(row.hero)}` : `${hero(row.hero)}<small>умер от крипов или башни</small>`}</span>
        <span class="map-where">${esc(row.zone)}</span>
        ${cost.length > 0 ? `<span class="map-cost">${esc(cost.join(' · '))}</span>` : ''}
        ${row.reasons.length > 0 ? `<span class="map-why">${esc(row.reasons.join(', '))}</span>` : ''}
      </span>
    </button>`;
}

function mapButtons(items, active, action) {
  return items.map(([key, label]) => `<button type="button" class="pro-pill plain ${key === active ? 'active' : ''}" onclick="${action}('${key}')">${esc(label)}</button>`).join('');
}

function mapWardPin(ward, index) {
  return `<g class="map-pin" data-pin="${index}" onclick="mapFocus(${index})"><title>${esc(`${formatClock(ward.time)}: ${WARD_NAMES[ward.type]}, ${ward.zone}`)}</title>${wardIcon(ward)}</g>`;
}

function mapWardRow(ward, index) {
  const hero = ward.hero ? `<span class="map-hero"><img loading="lazy" decoding="async" src="${getHeroIcon(ward.hero)}" alt="">${esc(getHeroName(ward.hero))}</span>` : '';
  return `
    <button type="button" class="map-row" data-row="${index}" onclick="mapFocus(${index})" onmouseenter="mapFocus(${index}, true)">
      <span class="map-index">${index + 1}</span>
      <span class="map-body">
        <span class="map-top"><strong>${esc(formatClock(ward.time))}</strong>${hero}<small>${esc(WARD_NAMES[ward.type] || 'вард')}</small></span>
        <span class="map-where">${esc(ward.zone)}</span>
        <span class="map-cost">${ward.destroyed ? 'снесли через' : 'простоял'} ${esc(formatClock(ward.end - ward.time))}</span>
      </span>
    </button>`;
}

function mapFilteredWards() {
  const [, , from, to] = MAP_PHASES.find(item => item[0] === mapView.phase);
  return mapView.wards.filter(ward => ward.time >= from && ward.time < to);
}

function mapWardSummary(rows) {
  if (rows.length === 0) return '';
  const radiant = mapView.viewer.player_slot < 128;
  const ours = rows.filter(ward => ward.radiant === radiant);
  const lost = ours.filter(ward => ward.destroyed).length;
  return `Твоя команда поставила ${ours.length}, враг ${rows.length - ours.length}. У команды снесли ${lost}.`;
}

function renderDeathView() {
  const box = document.getElementById('rp-death-map');
  const wardMode = mapView.who === 'wards';
  const rows = wardMode ? mapFilteredWards() : mapFiltered(mapView.rows, mapView.viewer, mapView.who, mapView.phase);
  mapView.shown = rows;
  mapView.focus = null;
  const empty = wardMode ? 'Вардов здесь нет.' : mapView.who === 'me' ? 'Твоих смертей здесь нет.' : 'Здесь событий нет.';
  box.innerHTML = `
    <div class="flex flex-wrap gap-2">${mapButtons(MAP_FILTERS, mapView.who, 'mapSetWho')}</div>
    <div class="flex flex-wrap gap-2">${mapButtons(MAP_PHASES, mapView.phase, 'mapSetPhase')}</div>
    <p class="text-sm text-slate-300">${esc((wardMode ? mapWardSummary(rows) : mapSummary(rows, mapView.who)) || empty)}</p>
    <div class="map-wrap">
      <div class="space-y-3">
        <svg class="death-map" viewBox="0 0 100 100" role="img" aria-label="Карта матча">
          ${mapBackground('match')}
          ${rows.map(wardMode ? mapWardPin : mapPin).join('')}
        </svg>
        <div id="map-detail" aria-live="polite"></div>
      </div>
      <div class="map-list">${rows.map(wardMode ? mapWardRow : mapRowHtml).join('')}</div>
    </div>
    <p class="text-xs text-slate-400">Нажми на строку или значок, чтобы разобрать момент отдельно. Схема карты, названия мест примерные. Красная рамка: твоя команда, синяя: враги.</p>`;
}

async function mapSetWho(who) {
  mapView.who = who;
  if (who === 'wards') {
    await mapLoadPlayback();
    if (mapView.who !== who) return;
  }
  renderDeathView();
}

// Позиции и варды приходят вместе с повтором
async function mapLoadPlayback() {
  const m = currentActiveReplayMatch;
  if (!m) return false;
  await replayFetch(m);
  if (replay.matchId !== m.match_id) return false;
  mapView.wards = replay.wards;
  return true;
}

function mapSetPhase(phase) {
  mapView.phase = phase;
  renderDeathView();
}

// Выбранный герой выносится наверх, иначе соседние значки его закрывают
function mapFocus(index, fromHover = false) {
  if (fromHover && mapView.focus === index) return;
  mapView.focus = index;
  const box = document.getElementById('rp-death-map');
  box.querySelectorAll('.map-pin.active, .map-row.active').forEach(item => item.classList.remove('active'));
  const pin = box.querySelector(`[data-pin="${index}"]`);
  const row = box.querySelector(`[data-row="${index}"]`);
  if (pin) {
    pin.classList.add('active');
    pin.parentNode.appendChild(pin);
  }
  if (row) row.classList.add('active');
  if (!fromHover) {
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    mapExplain(index);
  }
}

// Отдельный разбор одного момента: смерти или варда
async function mapExplain(index) {
  const item = mapView.shown[index];
  const box = document.getElementById('map-detail');
  if (!item || !box) return;
  const wardMode = mapView.who === 'wards';
  box.innerHTML = '<p class="text-sm text-slate-400">Разбираю момент...</p>';
  await mapLoadPlayback();
  if (mapView.shown[index] !== item) return;

  const player = wardMode ? null : mapView.match.players.find(p => p.hero_id === item.hero);
  const moment = wardMode ? wardMoment(item, mapView.viewer) : replayDeathMoment(item, player);
  box.innerHTML = momentHtml(moment, formatClock(moment.time), `<button type="button" class="pro-btn" onclick="replayJump(${Math.max(0, Math.round(item.time))})">Открыть в повторе</button>`);
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
    mapView.wards = [];
  }
  renderDeathView();
}
