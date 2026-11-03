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

// Рисуем местность один раз на холсте: тысячи деревьев внутри SVG тормозили бы повтор.
// Это наша схема: положения приблизительные, половина карты задана вручную, вторая получается поворотом.
const MAP_TEXTURE_SIZE = 1400;
const MAP_PATHS = [
  [5, [[13, 86], [12, 62], [11, 40], [11, 20], [15, 13], [30, 12], [50, 12], [68, 13], [80, 12]]],
  [5, [[14, 87], [45, 87], [62, 87], [80, 88], [87, 84], [90, 70], [90, 48], [90, 30]]],
  [5, [[15, 84], [33, 66], [42, 57], [52, 47], [62, 39], [76, 26]]],
  [3.2, [[12, 47], [22, 46], [29, 43], [36, 46], [42, 50]]],
  [3.2, [[12, 58], [22, 58], [30, 61], [36, 68], [41, 74], [43, 86]]],
  [3.2, [[30, 61], [33, 52], [40, 47]]],
  [3.2, [[15, 25], [25, 30], [34, 33]]],
  [3.2, [[22, 46], [21, 35], [16, 28]]],
  [3, [[50, 62], [50, 72], [52, 86]]],
  [3, [[28, 12], [30, 22], [37, 30], [41, 40]]]
];
const MAP_RIVERS = [
  [5.4, [[-2, 34], [8, 35], [18, 33], [28, 35], [38, 37], [46, 42], [50, 48]]],
  [5.8, [[46, -2], [48, 10], [51, 22], [50, 34], [48, 42]]]
];
const MAP_LAKES = [[5, 35, 4.5], [54, 24, 6.5], [30, 36, 4.5], [44, 8, 3.5]];
const MAP_HILLS = [[27, 51, 10], [38, 25, 9], [20, 20, 6], [62, 12, 5], [8, 50, 5]];
const MAP_BASE = [[-2, 66], [19, 67], [29, 76], [30, 102], [-2, 102]];
const MAP_STAIRS = [
  [38, 13, 90], [42, 13, 90], [33, 17, 0], [30, 25, 90], [37, 32, -40], [45, 37, 0], [47, 26, 0], [9, 18, -40],
  [22, 46, -45], [33, 43, 45], [31, 52, 90], [30, 60, -45], [12, 67, 0], [7, 58, 90], [4, 47, 0], [18, 61, 45],
  [26, 71, 45], [31, 86, 90], [24, 69, 45], [57, 9, 90], [36, 62, 45], [15, 41, 90]
];
const MAP_CAMPS = [
  [33.3, 4.8], [52.8, 2.8], [63, 1.7], [45.6, 19.6], [27.1, 20.3], [35, 26.2], [58, 24], [57.1, 33.8], [26.5, 43.5], [20.5, 50],
  [0.8, 52.5], [2.2, 60.5], [42, 69.5], [38.8, 78.5], [51.8, 80.8], [62.4, 73.4], [71.3, 57.8], [77, 49], [78.9, 71.7], [74.9, 79.8],
  [98.7, 50], [46.4, 95.7]
];
const MAP_WATCHERS = [[11.7, 9], [46.7, 6.2], [41.6, 25.6], [29.7, 49], [3.6, 43], [67.2, 53], [98.7, 58.3], [57, 75], [55.4, 95.4], [90.3, 89]];
const MAP_RINGS = [[11.7, 3.7, 2], [89.7, 93.7, 2], [5.2, 24, 0.9], [96.2, 76, 0.9], [4.5, 11, 1.6], [98, 86, 1.6]];
const MAP_ROSHAN_LAIRS = [[30.8, 35.4], [68.7, 65]];
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

function mapTurn(points) {
  return points.map(([x, y]) => [100 - x, 100 - y]);
}

function mapBothSides(list) {
  return [...list, ...list.map(([width, points]) => [width, mapTurn(points)])];
}

function mapDistanceTo(x, y, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, mapSegmentDistance(x, y, points[i - 1], points[i]));
  return best;
}

function mapInside(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function mapStroke(ctx, points, color, width) {
  ctx.beginPath();
  points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function mapShape(ctx, points, color) {
  ctx.beginPath();
  points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Неровное пятно: круг с дрожащим краем, чтобы холмы и озёра не выглядели как циркуль
function mapBlob(x, y, radius, random) {
  const points = [];
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    const reach = radius * (0.82 + random() * 0.3);
    points.push([x + Math.cos(angle) * reach, y + Math.sin(angle) * reach]);
  }
  return points;
}

function mapDrawStairs(ctx, x, y, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.fillStyle = 'rgba(8, 14, 11, .55)';
  ctx.fillRect(-2, -1.15, 4, 2.3);
  ctx.strokeStyle = 'rgba(120, 145, 128, .24)';
  ctx.lineWidth = 0.12;
  for (let line = -0.9; line <= 0.95; line += 0.45) {
    ctx.beginPath();
    ctx.moveTo(-2, line);
    ctx.lineTo(2, line);
    ctx.stroke();
  }
  ctx.restore();
}

function mapDrawTree(ctx, x, y, size, light) {
  const tier = (top, half, bottom) => {
    ctx.beginPath();
    ctx.moveTo(x, y + top * size);
    ctx.lineTo(x + half * size, y + bottom * size);
    ctx.lineTo(x - half * size, y + bottom * size);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  ctx.fillStyle = light ? '#14261D' : '#0E1B15';
  ctx.strokeStyle = 'rgba(92, 128, 105, .32)';
  ctx.lineWidth = 0.09;
  tier(-1.1, 0.62, 0.05);
  tier(-0.5, 0.78, 0.7);
}

function mapDrawTrees(ctx, random, isOpen) {
  const trees = [];
  for (let gridY = 0; gridY < 100; gridY += 1.3) {
    for (let gridX = 0; gridX < 100; gridX += 1.3) {
      const x = gridX + random() * 1.3;
      const y = gridY + random() * 1.3;
      if (random() > 0.12 && !isOpen(x, y)) trees.push([x, y, 0.85 + random() * 0.6, random() > 0.5]);
    }
  }
  trees.sort((a, b) => a[1] - b[1]).forEach(([x, y, size, light]) => mapDrawTree(ctx, x, y, size, light));
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

  const paths = mapBothSides(MAP_PATHS);
  const rivers = mapBothSides(MAP_RIVERS);
  const lakes = [...MAP_LAKES, ...MAP_LAKES.map(([x, y, r]) => [100 - x, 100 - y, r])];
  const hills = [...MAP_HILLS, ...MAP_HILLS.map(([x, y, r]) => [100 - x, 100 - y, r])];
  const bases = [MAP_BASE, mapTurn(MAP_BASE)];

  ctx.fillStyle = '#121C17';
  ctx.fillRect(0, 0, 100, 100);

  // Земля рисуется несколькими проходами со смещением: край получается рваным, а не как у трубы.
  // Размытие дорогое, поэтому фигуры собираются в один путь и размываются разом.
  const soft = pixels => {
    ctx.filter = pixels > 0 ? `blur(${pixels}px)` : 'none';
  };
  const addShape = (path, points) => {
    points.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
    path.closePath();
  };
  const addLine = (path, points) => {
    points.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  };
  const clearings = new Path2D();
  hills.forEach(([x, y, radius]) => addShape(clearings, mapBlob(x, y, radius, random)));
  MAP_CAMPS.forEach(([x, y]) => addShape(clearings, mapBlob(x, y, 2.6, random)));
  soft(5);
  bases.forEach((base, index) => mapShape(ctx, base, index === 0 ? '#2F4135' : '#283530'));
  ctx.fillStyle = '#2B3B30';
  ctx.fill(clearings);
  [5, 3.2, 3].forEach(width => {
    [[1.15, '#26332A'], [0.85, 'rgba(56, 74, 60, .7)']].forEach(([scale, color]) => {
      const lanes = new Path2D();
      paths.filter(([size]) => size === width).forEach(([, points]) => {
        addLine(lanes, points.map(([x, y]) => [x + (random() - 0.5) * 1.5, y + (random() - 0.5) * 1.5]));
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = width * scale;
      ctx.stroke(lanes);
    });
  });

  const light = new Path2D();
  const dark = new Path2D();
  for (let i = 0; i < 1500; i++) {
    const x = random() * 100;
    const y = random() * 100;
    const radius = 0.3 + random() * 2.2;
    const target = random() > 0.5 ? light : dark;
    target.moveTo(x + radius, y);
    target.arc(x, y, radius, 0, Math.PI * 2);
  }
  soft(4);
  ctx.fillStyle = 'rgba(140, 170, 150, .05)';
  ctx.fill(light);
  ctx.fillStyle = 'rgba(0, 0, 0, .13)';
  ctx.fill(dark);

  const shore = (extra, color) => {
    const water = new Path2D();
    rivers.forEach(([width, points]) => {
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 1.4);
        for (let step = 0; step <= steps; step++) {
          const x = ax + ((bx - ax) * step) / steps + (random() - 0.5) * 1.1;
          const y = ay + ((by - ay) * step) / steps + (random() - 0.5) * 1.1;
          const radius = (width / 2) * (0.82 + random() * 0.3) + extra;
          water.moveTo(x + radius, y);
          water.arc(x, y, radius, 0, Math.PI * 2);
        }
      }
    });
    lakes.forEach(([x, y, radius]) => addShape(water, mapBlob(x, y, radius + extra, random)));
    ctx.fillStyle = color;
    ctx.fill(water);
  };
  soft(3);
  shore(0.8, '#0A1619');
  soft(2);
  shore(0, '#0E2A33');
  soft(7);
  shore(-1.5, 'rgba(26, 70, 80, .5)');
  soft(0);
  for (let i = 0; i < 320; i++) {
    const [width, points] = rivers[Math.floor(random() * rivers.length)];
    const part = Math.floor(random() * (points.length - 1));
    const share = random();
    const x = points[part][0] + (points[part + 1][0] - points[part][0]) * share + (random() - 0.5) * width * 0.8;
    const y = points[part][1] + (points[part + 1][1] - points[part][1]) * share + (random() - 0.5) * width * 0.8;
    ctx.fillStyle = 'rgba(130, 190, 200, .08)';
    ctx.fillRect(x, y, 0.5 + random() * 0.9, 0.08);
  }
  MAP_ROSHAN_LAIRS.forEach(([x, y]) => mapShape(ctx, mapBlob(x, y, 3, random), '#0B1414'));

  bases.forEach(base => {
    mapStroke(ctx, base, 'rgba(6, 10, 8, .9)', 0.9);
    mapStroke(ctx, base, 'rgba(130, 160, 140, .22)', 0.16);
  });
  [...MAP_STAIRS, ...MAP_STAIRS.map(([x, y, angle]) => [100 - x, 100 - y, angle])].forEach(([x, y, angle]) => mapDrawStairs(ctx, x, y, angle));

  const isOpen = (x, y) => paths.some(([width, points]) => mapDistanceTo(x, y, points) < width / 2 + 0.2)
    || rivers.some(([width, points]) => mapDistanceTo(x, y, points) < width / 2 + 1.1)
    || lakes.some(([lakeX, lakeY, radius]) => Math.hypot(x - lakeX, y - lakeY) < radius + 1.3)
    || hills.some(([hillX, hillY, radius]) => Math.hypot(x - hillX, y - hillY) < radius * 0.42)
    || bases.some(base => mapInside(x, y, base) && Math.hypot(x - (base === bases[0] ? 13 : 87), y - (base === bases[0] ? 86 : 14)) < 15)
    || MAP_CAMPS.some(([campX, campY]) => Math.hypot(x - campX, y - campY) < 1.7);
  mapDrawTrees(ctx, random, isOpen);

  [[10, 90, 'rgba(110, 200, 140, .12)'], [90, 10, 'rgba(220, 90, 70, .1)']].forEach(([x, y, color]) => {
    const glow = ctx.createRadialGradient(x, y, 2, x, y, 34);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 100, 100);
  });
  const edge = ctx.createRadialGradient(50, 50, 48, 50, 50, 76);
  edge.addColorStop(0, 'rgba(0, 0, 0, 0)');
  edge.addColorStop(1, 'rgba(0, 0, 0, .7)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, 100, 100);

  return canvas.toDataURL('image/jpeg', 0.84);
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

function mapLandmarks() {
  const camps = MAP_CAMPS.map(([x, y]) => `<path d="M${x} ${y - 1} l1.15 1.95 h-2.3 z"/>`).join('');
  const watchers = MAP_WATCHERS.map(([x, y]) => `<rect x="${x - 0.55}" y="${y - 0.9}" width="1.1" height="1.8" rx=".3"/><path d="M${x - 0.3} ${y - 1.2} h.6"/>`).join('');
  const rings = MAP_RINGS.map(([x, y, radius]) => `<circle cx="${x}" cy="${y}" r="${radius}"/>`).join('');
  return `
    <g class="map-camps">${camps}</g>
    <g class="map-marks">${watchers}${rings}</g>`;
}

function mapBackground(id, bare = false) {
  const texture = bare ? '' : mapTexture();
  return `
    <defs>
      <radialGradient id="${id}-good"><stop offset="0" stop-color="#6EE7B7"/><stop offset="1" stop-color="#6EE7B7" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}-bad"><stop offset="0" stop-color="#FCA5A5"/><stop offset="1" stop-color="#FCA5A5" stop-opacity="0"/></radialGradient>
      <clipPath id="${id}-pin" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath>
    </defs>
    ${bare ? '' : '<rect width="100" height="100" fill="#18261F"/>'}
    ${texture ? `<image href="${texture}" width="100" height="100"/>` : ''}
    ${mapLandmarks()}
    ${bare ? '' : `
      ${mapTowers(MAP_TOWERS.radiant, '#6EE7B7')}${mapTowers(MAP_TOWERS.dire, '#FCA5A5')}
      <rect x="12.8" y="82.8" width="4.4" height="4.4" rx=".9" fill="#34D399" stroke="#06170F" stroke-width=".5" transform="rotate(45 15 85)"/>
      <rect x="82.8" y="12.8" width="4.4" height="4.4" rx=".9" fill="#F87171" stroke="#1A0606" stroke-width=".5" transform="rotate(45 85 15)"/>`}`;
}

// ─── Варды ──────────────────────────────────────────────────────────────

const WARD_LIFE = { OBSERVER: 360, SENTRY: 420 };
const WARD_NAMES = { OBSERVER: 'Обзорный вард', SENTRY: 'Сентри' };
const WARD_VISION = 9.6;
const WARD_TRUE_SIGHT = 6;
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

function wardIcon(ward, extra = '', ally = ward.radiant) {
  const { x, y } = ward;
  const team = ally ? '#34D399' : '#F87171';
  const pupil = ward.type === 'SENTRY' ? '#60A5FA' : '#FDE047';
  const reach = ward.type === 'SENTRY' ? WARD_TRUE_SIGHT : WARD_VISION;
  return `
    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${reach}" fill="${team}" fill-opacity=".14" stroke="${team}" stroke-opacity=".55" stroke-width=".22" ${ward.type === 'SENTRY' ? 'stroke-dasharray=".8 .6"' : ''}/>
    <g ${extra} transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
      <path d="M-2 0 Q0 -1.7 2 0 Q0 1.7 -2 0 Z" fill="#0B1411" stroke="${team}" stroke-width=".32"/>
      <circle r=".72" fill="${pupil}"/>
    </g>`;
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
  document.getElementById('rp-death-wrap').classList.toggle('hidden', rows.length === 0);
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
