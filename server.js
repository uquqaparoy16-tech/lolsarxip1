'use strict';

/**
 * Сервер Dota 2 True Skill. Зависимостей нет, нужен Node.js 18+.
 *
 * Адреса /api/od/... повторяют формат OpenDota, поэтому сайт работает с ними так же,
 * как с настоящим API. Матчи ищутся по цепочке: OpenDota -> STRATZ -> Steam.
 * Ключи читаются из .env и наружу не отдаются.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ANONYMOUS_ID = 4294967295;
const STEAM64_BASE = 76561197960265728n;
const MATCH_LIMIT = 20;
const PARALLEL_REQUESTS = 6; // сколько матчей загружаем одновременно
const REQUEST_TIMEOUT_MS = 15000;
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE) || 60;
const STATIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  });
}
loadEnvFile();

// Частые ошибки при заполнении .env: лишний текст "Key:" и ключ Steam не в той строке
function cleanSecret(value) {
  return String(value || '').replace(/^key:\s*/i, '').trim();
}

let steamKey = cleanSecret(process.env.STEAM_API_KEY);
let stratzToken = cleanSecret(process.env.STRATZ_TOKEN);
let steamKeyMoved = false;
if (!steamKey && /^[0-9A-F]{32}$/i.test(stratzToken)) {
  steamKey = stratzToken;
  stratzToken = '';
  steamKeyMoved = true;
}

const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  trustProxy: process.env.TRUST_PROXY === '1',
  steamKey,
  stratzToken,
  opendotaKey: process.env.OPENDOTA_API_KEY || '',
  opendota: process.env.OPENDOTA_BASE || 'https://api.opendota.com/api',
  steam: process.env.STEAM_BASE || 'https://api.steampowered.com',
  stratz: process.env.STRATZ_URL || 'https://api.stratz.com/graphql'
};

const lastErrors = { opendota: null, stratz: null, steam: null };
let lastSteamCheck = null;

class UpstreamError extends Error {
  constructor(source, status, message) {
    super(message);
    this.source = source;
    this.status = status;
  }
}

function noteError(source, message) {
  lastErrors[source] = { message, at: new Date().toISOString() };
}

// ─── Кэш ────────────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_MAX = 2000;
const TTL = { player: 5 * 60 * 1000, match: 24 * 60 * 60 * 1000 };

async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

// ─── Ограничение частоты ────────────────────────────────────────────────

const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (hits.size > 10000) hits.clear();
    hits.set(ip, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_MINUTE;
}

function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

// ─── Запросы наружу ─────────────────────────────────────────────────────

async function fetchJson(source, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    // В тексте ошибки нет адреса: в адресе Steam лежит ключ
    throw new UpstreamError(source, 502, e.name === 'AbortError' ? 'нет ответа за 15 секунд' : 'нет соединения');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new UpstreamError(source, res.status, `код ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new UpstreamError(source, 502, 'ответ не JSON');
  }
}

// ─── OpenDota ───────────────────────────────────────────────────────────

function opendotaUrl(pathname) {
  const key = config.opendotaKey ? `?api_key=${encodeURIComponent(config.opendotaKey)}` : '';
  return `${config.opendota}${pathname}${key}`;
}

const odGet = pathname => fetchJson('opendota', opendotaUrl(pathname));

// ─── STRATZ ─────────────────────────────────────────────────────────────

// Имена полей у STRATZ менялись, а неизвестное поле ломает весь запрос.
// Поэтому при первом обращении спрашиваем схему и берём те имена, что есть.
// Первым в списке стоит вариант, который используется, если схема недоступна.
const STRATZ_PLAYER_FIELDS = {
  heroId: ['heroId'],
  isRadiant: ['isRadiant'],
  playerSlot: ['playerSlot'],
  numKills: ['kills', 'numKills'],
  numDeaths: ['deaths', 'numDeaths'],
  numAssists: ['assists', 'numAssists'],
  goldPerMinute: ['goldPerMinute'],
  experiencePerMinute: ['experiencePerMinute'],
  towerDamage: ['towerDamage'],
  numLastHits: ['numLastHits', 'lastHits'],
  networth: ['networth', 'netWorth'],
  position: ['position'],
  imp: ['imp'],
  award: ['award']
};

let stratzPlayerSelection = null;

function buildPlayerSelection(available) {
  return Object.entries(STRATZ_PLAYER_FIELDS)
    .map(([alias, options]) => {
      const name = available ? options.find(option => available.has(option)) : options[0];
      if (!name) return null;
      return name === alias ? name : `${alias}: ${name}`;
    })
    .filter(Boolean)
    .join(' ');
}

async function stratzSelection() {
  if (stratzPlayerSelection) return stratzPlayerSelection;
  try {
    const data = await stratzQuery('{ __type(name: "MatchPlayerType") { fields { name } } }', {});
    const fields = data && data.__type && data.__type.fields;
    if (Array.isArray(fields) && fields.length > 0) {
      stratzPlayerSelection = buildPlayerSelection(new Set(fields.map(f => f.name)));
      return stratzPlayerSelection;
    }
  } catch (e) {
    noteError('stratz', `схема: ${e.message}`);
  }
  return buildPlayerSelection(null);
}

const stratzPlayerQuery = fields => `query Player($id: Long!, $take: Int!) {
  player(steamAccountId: $id) {
    steamAccount { name avatar seasonRank isAnonymous }
    matches(request: { take: $take }) {
      id didRadiantWin durationSeconds startDateTime gameMode lobbyType
      players(steamAccountId: $id) { ${fields} }
    }
  }
}`;

const stratzMatchQuery = fields => `query Match($id: Long!) {
  match(id: $id) {
    id didRadiantWin durationSeconds startDateTime gameMode lobbyType
    players { steamAccountId steamAccount { name } ${fields} }
  }
}`;

// Данные уровня реплея: без них разбор сводится к итоговым цифрам
const STRATZ_DETAIL_QUERY = `query Detail($id: Long!) {
  match(id: $id) {
    firstBloodTime topLaneOutcome midLaneOutcome bottomLaneOutcome radiantNetworthLeads
    players {
      heroId isRadiant lane role imp award numDenies
      stats {
        networthPerMinute lastHitsPerMinute
        deathEvents { time attacker goldLost goldFed timeDead positionX positionY isBurst isDieBack hasHealAvailable isAttemptTpOut isEngagedOnDeath }
        killEvents { time target isSolo isGank isSmoke }
        itemPurchases { time itemId }
        wards { time type }
      }
    }
  }
}`;

const STRATZ_GAME_MODES = { TURBO: 23, ALL_PICK_RANKED: 22, ALL_PICK: 1, CAPTAINS_MODE: 2, RANDOM_DRAFT: 3, SINGLE_DRAFT: 4, ALL_RANDOM: 5 };
const STRATZ_LOBBIES = { RANKED: 7, UNRANKED: 0, PRACTICE: 1, TOURNAMENT: 2 };

async function stratzQuery(query, variables) {
  const body = await fetchJson('stratz', config.stratz, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.stratzToken}`,
      'User-Agent': 'STRATZ_API'
    },
    body: JSON.stringify({ query, variables })
  });
  if (body.errors && body.errors.length > 0 && !body.data) {
    throw new UpstreamError('stratz', 502, String(body.errors[0].message || 'ошибка GraphQL').slice(0, 200));
  }
  return body.data;
}

async function stratzDetail(matchId) {
  const data = await stratzQuery(STRATZ_DETAIL_QUERY, { id: Number(matchId) });
  const match = data && data.match;
  if (!match || !Array.isArray(match.players)) return null;

  const players = {};
  match.players.forEach(p => {
    const stats = p.stats || {};
    players[p.heroId] = {
      lane: p.lane || null,
      role: p.role || null,
      imp: p.imp ?? null,
      award: p.award && p.award !== 'NONE' ? p.award : null,
      denies: p.numDenies ?? null,
      networth: stats.networthPerMinute || [],
      lastHits: stats.lastHitsPerMinute || [],
      deaths: stats.deathEvents || [],
      kills: stats.killEvents || [],
      items: stats.itemPurchases || [],
      wards: stats.wards || []
    };
  });

  return {
    firstBlood: match.firstBloodTime ?? null,
    lanes: { top: match.topLaneOutcome, mid: match.midLaneOutcome, bottom: match.bottomLaneOutcome },
    leads: match.radiantNetworthLeads || [],
    players
  };
}

function stratzPosition(value) {
  const match = String(value || '').match(/^POSITION_([1-5])$/);
  return match ? Number(match[1]) : null;
}

function stratzSlot(player) {
  const index = Number(player.playerSlot) % 128 % 5;
  return player.isRadiant ? index : 128 + index;
}

function stratzPlayer(player) {
  return {
    player_slot: stratzSlot(player),
    hero_id: player.heroId,
    kills: player.numKills,
    deaths: player.numDeaths,
    assists: player.numAssists,
    gold_per_min: player.goldPerMinute,
    xp_per_min: player.experiencePerMinute,
    tower_damage: player.towerDamage,
    last_hits: player.numLastHits,
    net_worth: player.networth,
    position: stratzPosition(player.position),
    imp: player.imp ?? null,
    award: player.award && player.award !== 'NONE' ? player.award : null
  };
}

function stratzMatchHead(match) {
  return {
    match_id: match.id,
    radiant_win: match.didRadiantWin,
    duration: match.durationSeconds,
    start_time: match.startDateTime,
    game_mode: STRATZ_GAME_MODES[match.gameMode] ?? null,
    lobby_type: STRATZ_LOBBIES[match.lobbyType] ?? null
  };
}

async function stratzPlayerData(accountId) {
  const data = await stratzQuery(stratzPlayerQuery(await stratzSelection()), { id: Number(accountId), take: MATCH_LIMIT });
  const player = data && data.player;
  if (!player) return { account: null, matches: [] };
  const matches = (player.matches || [])
    .filter(m => m.players && m.players[0])
    .map(m => ({ ...stratzMatchHead(m), ...stratzPlayer(m.players[0]) }));
  return { account: player.steamAccount || null, matches };
}

async function stratzMatch(matchId) {
  const data = await stratzQuery(stratzMatchQuery(await stratzSelection()), { id: Number(matchId) });
  const match = data && data.match;
  if (!match || !Array.isArray(match.players) || match.players.length === 0) return null;
  const players = match.players.map(p => ({
    ...stratzPlayer(p),
    account_id: p.steamAccountId ?? null,
    personaname: (p.steamAccount && p.steamAccount.name) || null
  }));
  const score = radiant => players.filter(p => (p.player_slot < 128) === radiant).reduce((sum, p) => sum + (p.kills || 0), 0);
  return { ...stratzMatchHead(match), radiant_score: score(true), dire_score: score(false), players };
}

// ─── Steam ──────────────────────────────────────────────────────────────

function steamUrl(method, params) {
  const query = new URLSearchParams({ key: config.steamKey, ...params });
  return `${config.steam}/IDOTA2Match_570/${method}/v1/?${query}`;
}

// Ник из ссылки вида steamcommunity.com/id/nick превращаем в числовой ID
async function resolveVanity(name) {
  const query = new URLSearchParams({ key: config.steamKey, vanityurl: name });
  const body = await fetchJson('steam', `${config.steam}/ISteamUser/ResolveVanityURL/v1/?${query}`);
  const result = body.response || {};
  if (result.success !== 1 || !result.steamid) return null;
  return String(BigInt(result.steamid) - STEAM64_BASE);
}

async function steamMatchIds(accountId) {
  const body = await fetchJson('steam', steamUrl('GetMatchHistory', { account_id: accountId, matches_requested: MATCH_LIMIT }));
  const result = body.result || {};
  // Статус 15 у Steam означает, что игрок запретил показывать историю
  if (result.status === 15) return { hidden: true, history: [] };
  if (result.status !== 1) throw new UpstreamError('steam', 502, String(result.statusDetail || `статус ${result.status}`).slice(0, 200));
  return { hidden: false, history: result.matches || [] };
}

function steamPlayer(player) {
  return {
    player_slot: player.player_slot,
    account_id: player.account_id === ANONYMOUS_ID ? null : player.account_id ?? null,
    personaname: player.persona || null,
    hero_id: player.hero_id,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    gold_per_min: player.gold_per_min,
    xp_per_min: player.xp_per_min,
    tower_damage: player.tower_damage,
    hero_damage: player.hero_damage,
    last_hits: player.last_hits,
    denies: player.denies,
    net_worth: player.net_worth ?? ((player.gold ?? 0) + (player.gold_spent ?? 0))
  };
}

async function steamMatch(matchId) {
  const body = await fetchJson('steam', steamUrl('GetMatchDetails', { match_id: matchId, include_persona_names: 1 }));
  const result = body.result;
  if (!result || result.error || !Array.isArray(result.players)) return null;
  return {
    match_id: result.match_id,
    radiant_win: result.radiant_win,
    duration: result.duration,
    start_time: result.start_time,
    game_mode: result.game_mode,
    lobby_type: result.lobby_type,
    radiant_score: result.radiant_score,
    dire_score: result.dire_score,
    first_blood_time: result.first_blood_time,
    players: result.players.map(steamPlayer)
  };
}

// GetMatchDetails у Steam может отвечать ошибкой 500, поэтому подробности сначала берём из OpenDota
async function historyMatchDetails(matchId) {
  return cached(`history-match:${matchId}`, TTL.match, async () => {
    try {
      const match = await odGet(`/matches/${matchId}`);
      if (match && Array.isArray(match.players) && match.players.length > 0) return match;
    } catch (e) {
      if (e.status !== 404) noteError('opendota', e.message);
    }
    return steamMatch(matchId);
  });
}

function matchRow(match, player) {
  return {
    match_id: match.match_id,
    radiant_win: match.radiant_win,
    duration: match.duration,
    start_time: match.start_time,
    game_mode: match.game_mode,
    lobby_type: match.lobby_type,
    player_slot: player.player_slot,
    hero_id: player.hero_id,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    gold_per_min: player.gold_per_min,
    xp_per_min: player.xp_per_min,
    tower_damage: player.tower_damage,
    hero_damage: player.hero_damage,
    last_hits: player.last_hits,
    net_worth: player.net_worth
  };
}

async function steamPlayerMatches(accountId) {
  const { hidden, history } = await steamMatchIds(accountId);
  if (hidden) return { hidden: true, matches: [] };

  const isPlayer = p => String(p.account_id) === String(accountId);
  const check = { listed: history.length, loaded: 0, failed: 0, matched: 0 };
  const matches = [];

  for (let i = 0; i < history.length; i += PARALLEL_REQUESTS) {
    const part = history.slice(i, i + PARALLEL_REQUESTS);
    const batch = await Promise.allSettled(part.map(entry => historyMatchDetails(entry.match_id)));
    batch.forEach((item, index) => {
      if (item.status !== 'fulfilled' || !item.value) {
        check.failed += 1;
        if (item.status === 'rejected') noteError('steam', `матч: ${item.reason.message}`);
        return;
      }
      check.loaded += 1;
      const match = item.value;
      // В деталях матча игрок может быть анонимным, а в истории его слот известен
      const listed = (part[index].players || []).find(isPlayer);
      const player = match.players.find(isPlayer) || (listed && match.players.find(p => p.player_slot === listed.player_slot));
      if (!player) return;
      check.matched += 1;
      matches.push(matchRow(match, player));
    });
  }
  lastSteamCheck = check;
  return { hidden: false, matches };
}

// ─── Цепочка источников ─────────────────────────────────────────────────

async function tryStratz(load) {
  if (!config.stratzToken) return null;
  try {
    return await load();
  } catch (e) {
    noteError('stratz', e.message);
    return null;
  }
}

async function loadPlayer(accountId) {
  return cached(`player:${accountId}`, TTL.player, async () => {
    let profile = null;
    let opendotaFailure = null;
    try {
      profile = await odGet(`/players/${accountId}`);
    } catch (e) {
      noteError('opendota', e.message);
      opendotaFailure = e;
    }

    const stratzData = await tryStratz(() => stratzPlayerData(accountId));
    const account = stratzData && stratzData.account;

    if (!profile || !profile.profile) {
      if (account && account.name) {
        profile = {
          profile: { account_id: Number(accountId), personaname: account.name, avatarmedium: account.avatar || '' },
          rank_tier: account.seasonRank || null,
          leaderboard_rank: null
        };
      } else if (opendotaFailure && !stratzData) {
        throw opendotaFailure;
      }
    } else if (!profile.rank_tier && account && account.seasonRank) {
      profile = { ...profile, rank_tier: account.seasonRank };
    }

    return { profile: profile || {}, stratzMatches: stratzData ? stratzData.matches : null };
  });
}

// Списки матчей из OpenDota и Steam приходят без позиций, поэтому дополняем их из STRATZ
const stratzMatchCached = matchId => cached(`stratz-match:${matchId}`, TTL.match, () => stratzMatch(matchId));

async function addPositions(rows) {
  if (!config.stratzToken || rows.length === 0) return rows;

  const positions = new Map();
  for (let i = 0; i < rows.length; i += PARALLEL_REQUESTS) {
    const part = rows.slice(i, i + PARALLEL_REQUESTS);
    const matches = await Promise.all(part.map(row => tryStratz(() => stratzMatchCached(row.match_id))));
    matches.forEach((match, index) => {
      if (match) positions.set(String(part[index].match_id), new Map(match.players.map(p => [p.hero_id, p])));
    });
  }

  return rows.map(row => {
    const known = positions.get(String(row.match_id));
    const player = known && known.get(row.hero_id);
    return { ...row, position: row.position ?? (player && player.position) ?? null, imp: player ? player.imp : null };
  });
}

async function loadMatches(accountId) {
  return cached(`matches:${accountId}`, TTL.player, async () => {
    const { stratzMatches } = await loadPlayer(accountId);

    // STRATZ первым, когда есть матчи: только он отдаёт позиции в списке
    if (stratzMatches && stratzMatches.length > 0) {
      return { matches: stratzMatches, source: 'STRATZ', reason: '' };
    }

    let opendotaFailure = null;
    try {
      const list = await odGet(`/players/${accountId}/recentMatches`);
      if (Array.isArray(list) && list.length > 0) return { matches: await addPositions(list), source: 'OpenDota', reason: '' };
    } catch (e) {
      noteError('opendota', e.message);
      opendotaFailure = e;
    }

    if (config.steamKey) {
      try {
        const { hidden, matches } = await steamPlayerMatches(accountId);
        if (hidden) return { matches: [], source: 'Steam', reason: 'hidden' };
        if (matches.length > 0) return { matches: await addPositions(matches), source: 'Steam', reason: '' };
      } catch (e) {
        noteError('steam', e.message);
      }
    }

    if (opendotaFailure && !config.steamKey && !config.stratzToken) throw opendotaFailure;
    return { matches: [], source: '', reason: config.steamKey || config.stratzToken ? 'empty' : 'no_keys' };
  });
}

// STRATZ знает позиции, поэтому добавляем их в матч из любого источника. Сверяем по герою: он в матче один.
function withPositions(match, positionsMatch) {
  if (!positionsMatch) return match;
  const byHero = new Map(positionsMatch.players.map(p => [p.hero_id, p.position]));
  return { ...match, players: match.players.map(p => ({ ...p, position: p.position ?? byHero.get(p.hero_id) ?? null })) };
}

async function loadMatch(matchId) {
  return cached(`match:${matchId}`, TTL.match, async () => {
    const [stratz, details] = await Promise.all([
      tryStratz(() => stratzMatchCached(matchId)),
      tryStratz(() => stratzDetail(matchId))
    ]);

    let opendotaFailure = null;
    try {
      const match = await odGet(`/matches/${matchId}`);
      if (match && Array.isArray(match.players) && match.players.length > 0) return { ...withPositions(match, stratz), details };
    } catch (e) {
      if (e.status !== 404) {
        noteError('opendota', e.message);
        opendotaFailure = e;
      }
    }

    if (stratz) return { ...stratz, details };

    if (config.steamKey) {
      try {
        const match = await steamMatch(matchId);
        if (match) return { ...match, details };
      } catch (e) {
        noteError('steam', e.message);
      }
    }

    if (opendotaFailure) throw opendotaFailure;
    return null;
  });
}

// ─── HTTP ───────────────────────────────────────────────────────────────

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function sendStatic(res, file) {
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not Found' });
    // no-cache: браузер проверяет новую версию, поэтому обновления сайта видны сразу
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function postToOpenDota(res, pathname) {
  const body = await fetchJson('opendota', opendotaUrl(pathname), { method: 'POST' });
  sendJson(res, 200, body);
}

async function handleApi(req, res, pathname, url) {
  let match;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      sources: { opendota: true, stratz: !!config.stratzToken, steam: !!config.steamKey },
      lastErrors,
      steamCheck: lastSteamCheck
    });
  }

  if (req.method === 'GET' && (match = pathname.match(/^\/api\/resolve\/([\w-]{2,32})$/))) {
    if (!config.steamKey) return sendJson(res, 503, { error: 'Нет ключа Steam' });
    const accountId = await cached(`vanity:${match[1]}`, TTL.match, () => resolveVanity(match[1]));
    return accountId ? sendJson(res, 200, { account_id: accountId }) : sendJson(res, 404, { error: 'Not Found' });
  }

  if (req.method === 'GET' && pathname === '/api/items') {
    const items = await cached('items', TTL.match, () => odGet('/constants/item_ids'));
    return sendJson(res, 200, items);
  }

  if (req.method === 'GET' && pathname === '/api/od/search') {
    const query = String(url.searchParams.get('q') || '').trim();
    if (query.length < 2 || query.length > 40) return sendJson(res, 200, []);
    const found = await cached(`search:${query.toLowerCase()}`, TTL.player, async () => {
      const list = await fetchJson('opendota', `${config.opendota}/search?q=${encodeURIComponent(query)}${config.opendotaKey ? `&api_key=${encodeURIComponent(config.opendotaKey)}` : ''}`);
      return Array.isArray(list) ? list.slice(0, 8) : [];
    });
    return sendJson(res, 200, found);
  }

  if (req.method === 'GET' && (match = pathname.match(/^\/api\/od\/players\/(\d{1,10})$/))) {
    const { profile } = await loadPlayer(match[1]);
    return sendJson(res, 200, profile);
  }

  if (req.method === 'GET' && (match = pathname.match(/^\/api\/od\/players\/(\d{1,10})\/recentMatches$/))) {
    const { matches, source, reason } = await loadMatches(match[1]);
    return sendJson(res, 200, matches, { 'X-Data-Source': source, 'X-Data-Reason': reason });
  }

  // Вся цепочка уже отработала в recentMatches, запасной запрос сайта повторять незачем
  if (req.method === 'GET' && /^\/api\/od\/players\/\d{1,10}\/matches$/.test(pathname)) {
    return sendJson(res, 200, []);
  }

  if (req.method === 'GET' && (match = pathname.match(/^\/api\/od\/matches\/(\d{6,12})$/))) {
    const data = await loadMatch(match[1]);
    return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: 'Not Found' });
  }

  if (req.method === 'POST' && (match = pathname.match(/^\/api\/od\/players\/(\d{1,10})\/refresh$/))) {
    cache.delete(`player:${match[1]}`);
    cache.delete(`matches:${match[1]}`);
    return postToOpenDota(res, `/players/${match[1]}/refresh`);
  }

  if (req.method === 'POST' && (match = pathname.match(/^\/api\/od\/request\/(\d{6,12})$/))) {
    cache.delete(`match:${match[1]}`);
    return postToOpenDota(res, `/request/${match[1]}`);
  }

  return sendJson(res, 400, { error: 'Некорректный запрос' });
}

const server = http.createServer(async (req, res) => {
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = url.pathname;
  } catch (e) {
    return sendJson(res, 400, { error: 'Некорректный запрос' });
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET' && STATIC_FILES[pathname]) return sendStatic(res, STATIC_FILES[pathname]);
    return sendJson(res, 404, { error: 'Not Found' });
  }

  if (isRateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: 'Слишком много запросов' }, { 'Retry-After': '60' });
  }

  try {
    await handleApi(req, res, pathname, url);
  } catch (e) {
    const status = e instanceof UpstreamError && e.status === 429 ? 429 : 503;
    if (!(e instanceof UpstreamError)) console.error('Ошибка сервера:', e.message);
    sendJson(res, status, { error: 'Источник данных недоступен' });
  }
});

if (require.main === module) {
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Порт ${config.port} уже занят: сервер запущен в другом окне. Закрой все чёрные окна и запусти снова.`);
    } else {
      console.error('Сервер не запустился:', e.message);
    }
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    console.log(`Сайт: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`STRATZ: ${config.stratzToken ? 'подключён' : 'нет токена'}, Steam: ${config.steamKey ? 'подключён' : 'нет ключа'}`);
    console.log(`Проверка .env: длина ключа Steam ${config.steamKey.length} (нужно 32), длина токена STRATZ ${config.stratzToken.length}`);
    if (steamKeyMoved) console.log('Ключ Steam стоял в строке STRATZ_TOKEN: сервер распознал его и использует как ключ Steam.');
  });
}

module.exports = { server, config };
