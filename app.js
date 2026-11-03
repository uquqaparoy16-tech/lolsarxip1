
function calculateMatchPerformanceGrade(m, isWin, profileTier, playerTrueMMR) {
  const baseMMR = playerTrueMMR || (profileTier ? rankTierToMMR(profileTier) : 1500);
  const kills = m.kills || 0;
  const deaths = m.deaths || 0;
  const assists = m.assists || 0;
  const gpm = m.gold_per_min || 0;
  const td = m.tower_damage || 0;
  const kda = (kills + assists) / Math.max(1, deaths);

  let delta = 0;
  // Win / loss base
  delta += isWin ? 160 : -160;

  // KDA impact
  if (kda >= 4.5) delta += 260;
  else if (kda >= 2.5) delta += 140;
  else if (kda >= 1.5) delta += 0;
  else if (kda < 1.0) delta -= 180;

  // Deaths impact relative to match duration
  const durationMin = Math.max(15, Math.round((m.duration || 1800) / 60));
  const deathsPerMin = deaths / durationMin;
  if (deaths === 0) delta += 320;
  else if (deaths <= 3) delta += 180;
  else if (deathsPerMin > 0.35 && deaths >= 8) delta -= 200;

  // Assists impact (heavy support / teamfight contribution)
  if (assists >= 25) delta += 220;
  else if (assists >= 18) delta += 130;

  // GPM impact
  if (gpm >= 800) delta += 260;
  else if (gpm >= 600) delta += 120;
  else if (gpm < 280 && kills < 2) delta -= 80;

  // Tower damage impact
  if (td >= 4000) delta += 180;
  else if (td >= 1800) delta += 80;

  let matchMMR = Math.max(50, Math.round(baseMMR + delta));
  const matchTier = mmrToRankTier(matchMMR);
  const rankTitle = getRankTitle(matchTier);

  let sub = '';
  if (isWin) {
    if (kda >= 4.0 || gpm >= 700) {
      sub = 'Сыграл на уровне выше своего ранга: отличный темп и доминация';
    } else if (assists >= 20) {
      sub = 'Колоссальный вклад в командные замесы (' + assists + ' ассистов)';
    } else {
      sub = 'Уверенная победа, стабильный вклад в результат';
    }
  } else {
    if (deaths >= 10 && kda < 1.0) {
      sub = 'Слишком много смертей (' + deaths + ') и потеря контроля над игрой';
    } else if (kda >= 2.0) {
      sub = 'Личный перформанс на уровне, но подвели командные ошибки';
    } else {
      sub = 'Не хватило темпа и контроля карты против агрессии врагов';
    }
  }

  return {
    grade: rankTitle + ' (~' + matchMMR + ' ПТС)',
    sub: sub,
    matchMMR: matchMMR
  };
}

// На сколько ПТС один пункт IMP сдвигает оценку матча: +30 IMP это примерно один ранг вверх
const IMP_POINTS = 25;

// Точка отсчёта та же, что в профиле: оценка игрока. Так ранги матчей не спорят с его ПТС.
function matchBaseMMR(m) {
  if (currentPlayerTrueMMR) return currentPlayerTrueMMR;
  if (m.average_rank) return rankTierToMMR(m.average_rank);
  return currentProfileTier ? rankTierToMMR(currentProfileTier) : 1500;
}

// На какой ранг сыгран матч: уровень игрока плюс его вклад в этот матч (IMP).
// Без IMP считаем по итоговым цифрам, а Турбо по таким цифрам не сравнить.
function matchRank(m) {
  const base = matchBaseMMR(m);
  let mmr;
  if (m.imp != null) {
    mmr = base + m.imp * IMP_POINTS;
  } else if (isTurbo(m) || !m.gold_per_min) {
    return null;
  } else {
    mmr = calculateMatchPerformanceGrade(m, wonMatch(m), currentProfileTier, currentPlayerTrueMMR).matchMMR;
  }
  mmr = Math.max(50, Math.round(mmr));
  const tier = mmrToRankTier(mmr);
  const baseTier = mmrToRankTier(base);
  return {
    mmr,
    tier,
    title: getRankTitle(tier).replace(/ \(.*\)$/, ''),
    tone: tier > baseTier ? 'up' : tier < baseTier ? 'down' : 'same'
  };
}

/**
 * Dota 2 True Skill Engine 3.0 (UC.ZONE Cyber Edition)
 * Deep Statistical Calibration • Role-Aware MMR Inspector • Replay AI Coach
 */

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS & RANK DATA
// ═══════════════════════════════════════════════════════════════════════

const RANK_NAMES = {
  1: 'Рекрут (Herald)',
  2: 'Страж (Guardian)',
  3: 'Рыцарь (Crusader)',
  4: 'Герой (Archon)',
  5: 'Легенда (Legend)',
  6: 'Властелин (Ancient)',
  7: 'Божество (Divine)',
  8: 'Титан (Immortal)'
};

const RANK_BASE_MMR = {
  1: 10,
  2: 770,
  3: 1540,
  4: 2310,
  5: 3080,
  6: 3850,
  7: 4620,
  8: 5620
};

// Примерные ориентиры по рангам: это оценка, а не данные Valve
const BENCHMARKS = {
  core: {
    gpm: { herald: 380, guardian: 460, crusader: 530, archon: 610, legend: 680, ancient: 750 },
    xpm: { herald: 410, guardian: 510, crusader: 610, archon: 710, legend: 780, ancient: 850 },
    deaths: { herald: 9.5, guardian: 7.8, crusader: 6.2, archon: 5.0, legend: 4.2, ancient: 3.6 },
    kda: { herald: 1.8, guardian: 2.4, crusader: 3.0, archon: 3.7, legend: 4.3, ancient: 5.0 },
    towerDamage: { herald: 1100, guardian: 1900, crusader: 2900, archon: 4200, legend: 5500, ancient: 7000 }
  },
  support: {
    gpm: { herald: 310, guardian: 360, crusader: 410, archon: 460, legend: 510, ancient: 560 },
    xpm: { herald: 380, guardian: 450, crusader: 520, archon: 600, legend: 660, ancient: 720 },
    deaths: { herald: 10.2, guardian: 8.5, crusader: 7.0, archon: 5.8, legend: 4.9, ancient: 4.2 },
    kda: { herald: 1.8, guardian: 2.3, crusader: 2.9, archon: 3.6, legend: 4.2, ancient: 4.8 },
    towerDamage: { herald: 400, guardian: 700, crusader: 1100, archon: 1600, legend: 2200, ancient: 3000 }
  }
};

// Complete Dota 2 Hero Database with High-Res Steam CDN icons
const HEROES_DB = {
  1: { name: 'Anti-Mage', slug: 'antimage', role: 'Carry' },
  2: { name: 'Axe', slug: 'axe', role: 'Offlane' },
  3: { name: 'Bane', slug: 'bane', role: 'Support' },
  4: { name: 'Bloodseeker', slug: 'bloodseeker', role: 'Carry/Mid' },
  5: { name: 'Crystal Maiden', slug: 'crystal_maiden', role: 'Support' },
  6: { name: 'Drow Ranger', slug: 'drow_ranger', role: 'Carry' },
  7: { name: 'Earthshaker', slug: 'earthshaker', role: 'Support/Offlane' },
  8: { name: 'Juggernaut', slug: 'juggernaut', role: 'Carry' },
  9: { name: 'Mirana', slug: 'mirana', role: 'Support/Roam' },
  10: { name: 'Morphling', slug: 'morphling', role: 'Carry' },
  11: { name: 'Shadow Fiend', slug: 'nevermore', role: 'Mid' },
  12: { name: 'Phantom Lancer', slug: 'phantom_lancer', role: 'Carry' },
  13: { name: 'Puck', slug: 'puck', role: 'Mid' },
  14: { name: 'Pudge', slug: 'pudge', role: 'Roam/Offlane' },
  15: { name: 'Razor', slug: 'razor', role: 'Carry/Mid' },
  16: { name: 'Sand King', slug: 'sand_king', role: 'Offlane' },
  17: { name: 'Storm Spirit', slug: 'storm_spirit', role: 'Mid' },
  18: { name: 'Sven', slug: 'sven', role: 'Carry' },
  19: { name: 'Tiny', slug: 'tiny', role: 'Mid/Roam' },
  20: { name: 'Vengeful Spirit', slug: 'vengefulspirit', role: 'Support' },
  21: { name: 'Windranger', slug: 'windrunner', role: 'Mid/Support' },
  22: { name: 'Zeus', slug: 'zuus', role: 'Mid/Support' },
  23: { name: 'Kunkka', slug: 'kunkka', role: 'Mid/Offlane' },
  25: { name: 'Lina', slug: 'lina', role: 'Mid/Carry' },
  26: { name: 'Lion', slug: 'lion', role: 'Support' },
  27: { name: 'Shadow Shaman', slug: 'shadow_shaman', role: 'Support' },
  28: { name: 'Slardar', slug: 'slardar', role: 'Offlane' },
  29: { name: 'Tidehunter', slug: 'tidehunter', role: 'Offlane' },
  30: { name: 'Witch Doctor', slug: 'witch_doctor', role: 'Support' },
  31: { name: 'Lich', slug: 'lich', role: 'Support' },
  32: { name: 'Riki', slug: 'riki', role: 'Carry' },
  33: { name: 'Enigma', slug: 'enigma', role: 'Offlane' },
  34: { name: 'Tinker', slug: 'tinker', role: 'Mid/Support' },
  35: { name: 'Sniper', slug: 'sniper', role: 'Mid/Carry' },
  36: { name: 'Necrophos', slug: 'necrolyte', role: 'Mid/Offlane' },
  37: { name: 'Warlock', slug: 'warlock', role: 'Support' },
  38: { name: 'Beastmaster', slug: 'beastmaster', role: 'Offlane' },
  39: { name: 'Queen of Pain', slug: 'queenofpain', role: 'Mid' },
  40: { name: 'Venomancer', slug: 'venomancer', role: 'Support/Offlane' },
  41: { name: 'Faceless Void', slug: 'faceless_void', role: 'Carry' },
  42: { name: 'Wraith King', slug: 'skeleton_king', role: 'Carry' },
  43: { name: 'Death Prophet', slug: 'death_prophet', role: 'Mid/Offlane' },
  44: { name: 'Phantom Assassin', slug: 'phantom_assassin', role: 'Carry' },
  45: { name: 'Pugna', slug: 'pugna', role: 'Support/Mid' },
  46: { name: 'Templar Assassin', slug: 'templar_assassin', role: 'Mid/Carry' },
  47: { name: 'Viper', slug: 'viper', role: 'Mid/Offlane' },
  48: { name: 'Luna', slug: 'luna', role: 'Carry' },
  49: { name: 'Dragon Knight', slug: 'dragon_knight', role: 'Mid/Offlane' },
  50: { name: 'Dazzle', slug: 'dazzle', role: 'Support' },
  51: { name: 'Clockwerk', slug: 'rattletrap', role: 'Offlane/Support' },
  52: { name: 'Leshrac', slug: 'leshrac', role: 'Mid' },
  53: { name: "Nature's Prophet", slug: 'furion', role: 'Offlane/Carry' },
  54: { name: 'Lifestealer', slug: 'life_stealer', role: 'Carry' },
  55: { name: 'Dark Seer', slug: 'dark_seer', role: 'Offlane' },
  56: { name: 'Clinkz', slug: 'clinkz', role: 'Carry' },
  57: { name: 'Omniknight', slug: 'omniknight', role: 'Offlane/Support' },
  58: { name: 'Enchantress', slug: 'enchantress', role: 'Support' },
  59: { name: 'Huskar', slug: 'huskar', role: 'Mid' },
  60: { name: 'Night Stalker', slug: 'night_stalker', role: 'Offlane' },
  61: { name: 'Broodmother', slug: 'broodmother', role: 'Mid/Offlane' },
  62: { name: 'Bounty Hunter', slug: 'bounty_hunter', role: 'Roam/Support' },
  63: { name: 'Weaver', slug: 'weaver', role: 'Carry/Support' },
  64: { name: 'Jakiro', slug: 'jakiro', role: 'Support' },
  65: { name: 'Batrider', slug: 'batrider', role: 'Mid/Offlane' },
  66: { name: 'Chen', slug: 'chen', role: 'Support' },
  67: { name: 'Spectre', slug: 'spectre', role: 'Carry' },
  68: { name: 'Ancient Apparition', slug: 'ancient_apparition', role: 'Support' },
  69: { name: 'Doom', slug: 'doom_bringer', role: 'Offlane' },
  70: { name: 'Ursa', slug: 'ursa', role: 'Carry' },
  71: { name: 'Spirit Breaker', slug: 'spirit_breaker', role: 'Roam/Offlane' },
  72: { name: 'Gyrocopter', slug: 'gyrocopter', role: 'Carry' },
  73: { name: 'Alchemist', slug: 'alchemist', role: 'Carry/Mid' },
  74: { name: 'Invoker', slug: 'invoker', role: 'Mid' },
  75: { name: 'Silencer', slug: 'silencer', role: 'Support/Mid' },
  76: { name: 'Outworld Destroyer', slug: 'obsidian_destroyer', role: 'Mid' },
  77: { name: 'Lycan', slug: 'lycan', role: 'Carry/Offlane' },
  78: { name: 'Brewmaster', slug: 'brewmaster', role: 'Offlane' },
  79: { name: 'Shadow Demon', slug: 'shadow_demon', role: 'Support' },
  80: { name: 'Lone Druid', slug: 'lone_druid', role: 'Carry/Mid' },
  81: { name: 'Chaos Knight', slug: 'chaos_knight', role: 'Carry' },
  82: { name: 'Meepo', slug: 'meepo', role: 'Mid' },
  83: { name: 'Treant Protector', slug: 'treant', role: 'Support' },
  84: { name: 'Ogre Magi', slug: 'ogre_magi', role: 'Support/Offlane' },
  85: { name: 'Undying', slug: 'undying', role: 'Support' },
  86: { name: 'Rubick', slug: 'rubick', role: 'Support' },
  87: { name: 'Disruptor', slug: 'disruptor', role: 'Support' },
  88: { name: 'Nyx Assassin', slug: 'nyx_assassin', role: 'Roam/Support' },
  89: { name: 'Naga Siren', slug: 'naga_siren', role: 'Carry' },
  90: { name: 'Keeper of the Light', slug: 'keeper_of_the_light', role: 'Support' },
  91: { name: 'Io', slug: 'wisp', role: 'Support' },
  92: { name: 'Visage', slug: 'visage', role: 'Mid/Support' },
  93: { name: 'Slark', slug: 'slark', role: 'Carry' },
  94: { name: 'Medusa', slug: 'medusa', role: 'Carry' },
  95: { name: 'Troll Warlord', slug: 'troll_warlord', role: 'Carry' },
  96: { name: 'Centaur Warrunner', slug: 'centaur', role: 'Offlane' },
  97: { name: 'Magnus', slug: 'magnataur', role: 'Offlane/Mid' },
  98: { name: 'Timbersaw', slug: 'shredder', role: 'Offlane/Mid' },
  99: { name: 'Bristleback', slug: 'bristleback', role: 'Offlane/Carry' },
  100: { name: 'Tusk', slug: 'tusk', role: 'Roam/Support' },
  101: { name: 'Skywrath Mage', slug: 'skywrath_mage', role: 'Support' },
  102: { name: 'Abaddon', slug: 'abaddon', role: 'Support/Offlane' },
  103: { name: 'Elder Titan', slug: 'elder_titan', role: 'Support' },
  104: { name: 'Legion Commander', slug: 'legion_commander', role: 'Offlane' },
  105: { name: 'Techies', slug: 'techies', role: 'Support' },
  106: { name: 'Ember Spirit', slug: 'ember_spirit', role: 'Mid/Carry' },
  107: { name: 'Earth Spirit', slug: 'earth_spirit', role: 'Roam' },
  108: { name: 'Underlord', slug: 'abyssal_underlord', role: 'Offlane' },
  109: { name: 'Terrorblade', slug: 'terrorblade', role: 'Carry' },
  110: { name: 'Phoenix', slug: 'phoenix', role: 'Support/Offlane' },
  111: { name: 'Oracle', slug: 'oracle', role: 'Support' },
  112: { name: 'Winter Wyvern', slug: 'winter_wyvern', role: 'Support' },
  113: { name: 'Arc Warden', slug: 'arc_warden', role: 'Carry/Mid' },
  114: { name: 'Monkey King', slug: 'monkey_king', role: 'Carry/Mid' },
  119: { name: 'Dark Willow', slug: 'dark_willow', role: 'Support' },
  120: { name: 'Pangolier', slug: 'pangolier', role: 'Offlane/Mid' },
  121: { name: 'Grimstroke', slug: 'grimstroke', role: 'Support' },
  123: { name: 'Hoodwink', slug: 'hoodwink', role: 'Support' },
  126: { name: 'Void Spirit', slug: 'void_spirit', role: 'Mid' },
  128: { name: 'Snapfire', slug: 'snapfire', role: 'Support/Mid' },
  129: { name: 'Mars', slug: 'mars', role: 'Offlane' },
  131: { name: 'Ringmaster', slug: 'ringmaster', role: 'Support' },
  135: { name: 'Dawnbreaker', slug: 'dawnbreaker', role: 'Offlane/Carry' },
  136: { name: 'Marci', slug: 'marci', role: 'Support/Carry' },
  137: { name: 'Primal Beast', slug: 'primal_beast', role: 'Offlane' },
  138: { name: 'Muerta', slug: 'muerta', role: 'Carry' },
  145: { name: 'Kez', slug: 'kez', role: 'Carry' },
  155: { name: 'Largo', slug: 'largo', role: 'Support' }
};

function getHeroIcon(heroId) {
  const h = HEROES_DB[heroId];
  if (h && h.slug) {
    return `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${h.slug}.png`;
  }
  // Неизвестный герой (новый патч): нейтральная заглушка, а не чужая иконка
  return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
}

function getHeroName(heroId) {
  return (HEROES_DB[heroId] && HEROES_DB[heroId].name) || `Герой #${heroId}`;
}

function isHeroSupport(heroId, gpm = 0, assists = 0, kills = 0) {
  const h = HEROES_DB[heroId];
  if (h && h.role === 'Support') return true;
  if (gpm > 0 && gpm < 440 && assists > kills) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// RANK BADGE RENDERER (Dual-layer: Base Medal + Star Overlay)
// ═══════════════════════════════════════════════════════════════════════

function renderRankBadgeInContainer(containerId, tier, isTrueSkill = false) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!tier) {
    container.innerHTML = '<div class="w-20 h-20 flex items-center justify-center text-4xl font-outfit font-black text-slate-600">?</div>';
    return;
  }

  const main = Math.min(8, Math.max(1, Math.floor(tier / 10)));
  const star = Math.min(5, Math.max(0, tier % 10));

  const medalUrl = `https://cdn.stratz.com/images/dota2/seasonal_rank/medal_${main}.png`;
  const medalFallback = `https://www.opendota.com/assets/images/dota2/rank_icons/rank_icon_${main}.png`;
  const starUrl = star > 0 && main < 8 ? `https://cdn.stratz.com/images/dota2/seasonal_rank/star_${star}.png` : null;

  const sizeClass = isTrueSkill ? 'w-24 h-24' : 'w-20 h-20';
  const animClass = '';

  container.innerHTML = `
    <div class="relative ${sizeClass} flex items-center justify-center ${animClass}">
      <img
        src="${medalUrl}"
        alt="Rank Medal"
        class="w-full h-full object-contain filter drop-shadow-md select-none pointer-events-none"
        onerror="this.onerror=null; this.src='${medalFallback}';"
      />
      ${starUrl ? `
        <img
          src="${starUrl}"
          alt="Star ${star}"
          class="absolute inset-0 w-full h-full object-contain pointer-events-none filter drop-shadow"
          onerror="this.style.display='none';"
        />
      ` : ''}
    </div>
  `;
}

function rankTierToMMR(tier) {
  if (!tier) return 85;
  const main = Math.floor(tier / 10);
  const star = Math.max(1, tier % 10);
  const base = RANK_BASE_MMR[main] || 85;
  return Math.round(base + (star - 1) * 154);
}

function mmrToRankTier(mmr) {
  if (mmr < 770) {
    const star = Math.min(5, Math.max(1, Math.floor(mmr / 154) + 1));
    return 10 + star;
  } else if (mmr < 1540) {
    const star = Math.min(5, Math.max(1, Math.floor((mmr - 770) / 154) + 1));
    return 20 + star;
  } else if (mmr < 2310) {
    const star = Math.min(5, Math.max(1, Math.floor((mmr - 1540) / 154) + 1));
    return 30 + star;
  } else if (mmr < 3080) {
    const star = Math.min(5, Math.max(1, Math.floor((mmr - 2310) / 154) + 1));
    return 40 + star;
  } else if (mmr < 3850) {
    const star = Math.min(5, Math.max(1, Math.floor((mmr - 3080) / 154) + 1));
    return 50 + star;
  } else if (mmr < 4620) {
    const star = Math.min(5, Math.max(1, Math.floor((mmr - 3850) / 154) + 1));
    return 60 + star;
  } else if (mmr < 5620) {
    const star = Math.min(5, Math.max(1, Math.floor((mmr - 4620) / 160) + 1));
    return 70 + star;
  } else {
    return 80;
  }
}

function getRankTitle(tier) {
  if (!tier) return 'Нет ранга';
  const main = Math.floor(tier / 10);
  const star = tier % 10;
  const name = RANK_NAMES[main] || 'Рекрут';
  if (main === 8) return 'Титан (Immortal)';
  return `${name.split(' ')[0]} ${star > 0 ? star : 1}`;
}

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════

// Через сервер данные идут с запасными источниками, а при открытии файлом напрямую из OpenDota
const SERVER_MODE = location.protocol !== 'file:';
const OPENDOTA = SERVER_MODE ? '/api/od' : 'https://api.opendota.com/api';
const STEAM64_BASE = 76561197960265728n;
const TURBO_GAME_MODE = 23;
const MATCH_FIELDS = ['match_id', 'player_slot', 'radiant_win', 'hero_id', 'start_time', 'duration', 'game_mode', 'lobby_type', 'kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'tower_damage', 'hero_damage', 'last_hits', 'average_rank'];

let currentAccountId = null;
let currentProfile = null;
let scanToken = 0;
let currentDataSource = '';
let currentDataReason = '';

class ApiError extends Error {}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Сайт не должен падать, если CDN с иконками не загрузился
function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function isTurbo(m) {
  return m.game_mode === TURBO_GAME_MODE;
}

// В Турбо GPM/XPM примерно вдвое выше обычных, поэтому при наличии обычных игр Турбо в оценку не идёт
function pickScoredMatches(matches) {
  const normal = matches.filter(m => !isTurbo(m));
  return normal.length >= 5 ? normal : matches;
}

function formatStat(value) {
  return value == null ? '—' : value.toLocaleString();
}

let currentMatches = [];
let radarChartInstance = null;
let currentPlayerName = 'Игрок';
let currentViewerHeroId = null;
let currentViewerSlot = null;
let currentReplayStoryData = null;
let selectedTeammateIndex = 0;
let currentProfileTier = null;
let currentPlayerTrueMMR = null;

const DAILY_TIPS = [
  "⚡ На Рекрутах (до 800 MMR) 75% поражений происходят из-за того, что игроки бьют лесных крипов вместо того, чтобы ломать вышки после выигранного файта. Сделал 2 фрага? Жми Т1 или Т2!",
  "🛡️ Черная полоса в Доте? Если ты проиграл 2 игры подряд — отойди от компа на 15 минут. В тильте время реакции падает на 30%, а количество смертей возрастает в 2 раза.",
  "🗺️ Смотри на миникарту каждые 3–5 секунд: так ты заранее видишь, кто пропал с линии, и не попадаешь под ганки.",
  "👁️ Вардинг на 10-й минуте: Самый сильный вард на низком рейтинге — на треугольнике врага. Он окупается в первую же минуту, когда ты убиваешь чужого кора в соло.",
  "⏱️ Тайминг BKB: На ранге Рыцарь (Crusader) BKB покупают к 22–26 минуте. На Рекрутах его не покупают вообще. Купи BKB 2-м слотом — и ты выиграешь 8 из 10 драк автоматически!",
  "⚔️ Ластхит в разминке: Если ты тратишь 10 минут перед первой каткой на разминку добиваний в лобби (Last Hit Trainer), твой средний GPM в реальной игре вырастает на +60!"
];

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  renderShowcaseButtons();
  selectShowcase('true-mmr');
  setDailyTip();
  const input = document.getElementById('dota-id-input');
  const urlId = new URLSearchParams(location.search).get('id');
  let savedId = '';
  try {
    savedId = localStorage.getItem('dota-last-id') || '';
  } catch (e) {}
  if (input) input.value = urlId || savedId;
  updateReplayEmptyState();
  if (urlId) analyzePlayer();
});

function rememberPlayer(accountId) {
  try {
    localStorage.setItem('dota-last-id', accountId);
    history.replaceState(null, '', `?id=${accountId}`);
  } catch (e) {}
}

function updateReplayEmptyState() {
  const hasMatch = !!currentActiveReplayMatch;
  const container = document.getElementById('replay-container');
  if (container) container.classList.toggle('hidden', !hasMatch);
  if (!hasMatch) showReplayNotice('Сначала введи свой ID на вкладке «Профиль» или вставь Match ID выше.');
}

function setDailyTip() {
  const el = document.getElementById('daily-tip');
  if (!el) return;
  el.textContent = DAILY_TIPS[Math.floor(Math.random() * DAILY_TIPS.length)];
}

function switchTab(tab) {
  const tabs = ['tracker', 'showcase', 'replay', 'draft', 'heroes', 'plan'];
  tabs.forEach(t => {
    const sec = document.getElementById(`sec-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (sec) sec.classList.add('hidden');
    if (btn) btn.className = 'tab-inactive px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors';
    if (btn) btn.removeAttribute('aria-current');
  });

  const activeSec = document.getElementById(`sec-${tab}`);
  const activeBtn = document.getElementById(`tab-btn-${tab}`);
  if (activeSec) activeSec.classList.remove('hidden');
  if (activeBtn) activeBtn.className = 'tab-active px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors';
  if (activeBtn) activeBtn.setAttribute('aria-current', 'page');
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (activeBtn) activeBtn.scrollIntoView({ inline: 'nearest', block: 'nearest' }); // на телефоне меню прокручивается

  if (tab === 'replay') {
    renderReplayPills();
    updateReplayEmptyState();
  }
  if (tab === 'draft' && typeof openDraft === 'function') openDraft();
  if (tab === 'heroes' && typeof openHeroes === 'function') openHeroes();

  refreshIcons();
}

function fillId(id) {
  const input = document.getElementById('dota-id-input');
  if (input) input.value = id;
  analyzePlayer();
}

// ═══════════════════════════════════════════════════════════════════════
// PROFILE LOADER & ANALYZER
// ═══════════════════════════════════════════════════════════════════════

function setScanning(active, stage = '') {
  const button = document.getElementById('scan-btn');
  if (button) button.disabled = active;
  document.getElementById('loading-stage').textContent = stage;
  document.getElementById('loading-state').classList.toggle('hidden', !active);
}

function animateNumber(element, value, format) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animationId = (element.__animationId || 0) + 1;
  element.__animationId = animationId;
  element.textContent = format(reduced ? value : 0);
  if (reduced) return;

  const startedAt = performance.now();
  const step = now => {
    if (element.__animationId !== animationId) return;
    const progress = Math.min(1, (now - startedAt) / 600);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = format(Math.round(value * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderPlayerHeader(profile, matchCount) {
  const info = profile.profile || {};
  document.getElementById('player-name').textContent = info.personaname || currentPlayerName;
  document.getElementById('player-sub').textContent = `Матчей в разборе: ${matchCount}`;
  const avatar = document.getElementById('player-avatar');
  avatar.src = info.avatarmedium || '';
  avatar.classList.toggle('hidden', !info.avatarmedium);
}

function hideScanStates() {
  ['error-state', 'loading-state', 'no-history-state', 'search-state', 'results'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
}

// Принимает friend ID, Steam64, [U:1:xxx] и ссылки на Steam / Dotabuff / OpenDota
function parseAccountId(raw) {
  const text = String(raw || '').trim();
  if (/steamcommunity\.com\/id\//i.test(text)) return null; // ник в ссылке, числового ID в ней нет

  const steam3 = text.match(/\[U:1:(\d+)\]/i);
  if (steam3) return steam3[1];

  const digits = text.match(/\d{3,20}/g);
  if (!digits) return null;
  const id = BigInt(digits[digits.length - 1]);
  if (id >= STEAM64_BASE) return String(id - STEAM64_BASE);
  return id > 0n && id <= 4294967295n ? String(id) : null;
}

async function resolveAccountId(raw) {
  const direct = parseAccountId(raw);
  if (direct) return direct;

  const vanity = String(raw).match(/steamcommunity\.com\/id\/([\w-]{2,32})/i);
  if (!vanity) {
    if (/https?:|\.com/i.test(raw) || String(raw).trim().length < 2) return null;
    return { search: String(raw).trim() };
  }
  if (!SERVER_MODE) throw new ApiError('Ссылка с ником работает только через сервер. Вставь числовой ID из профиля Доты.');

  let res;
  try {
    res = await fetch(`/api/resolve/${vanity[1]}`);
  } catch (e) {
    throw new ApiError('Нет связи с сервером.');
  }
  if (res.status === 404) throw new ApiError(`Профиль Steam «${vanity[1]}» не найден.`);
  if (!res.ok) throw new ApiError('Сейчас не получается открыть ссылку с ником. Вставь числовой ID из профиля Доты.');
  const data = await res.json();
  return String(data.account_id);
}

async function odFetch(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = SERVER_MODE ? 90000 : 20000; // при первом скане сервер собирает данные по всем матчам
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${OPENDOTA}${path}`, { ...options, signal: controller.signal });
  } catch (e) {
    throw new ApiError(e.name === 'AbortError'
      ? 'Источник данных отвечает слишком долго. Попробуй ещё раз.'
      : SERVER_MODE
        ? 'Нет связи с сервером. Проверь, запущен ли он.'
        : 'Нет связи с OpenDota. Проверь интернет или попробуй через минуту.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new ApiError('OpenDota временно ограничил запросы. Подожди минуту и попробуй снова.');
  if (res.status >= 500) throw new ApiError(`Сервер OpenDota сейчас недоступен (код ${res.status}).`);
  return res;
}

async function fetchPlayerMatches(accountId) {
  const recentRes = await odFetch(`/players/${accountId}/recentMatches`);
  currentDataSource = recentRes.headers.get('X-Data-Source') || 'OpenDota';
  currentDataReason = recentRes.headers.get('X-Data-Reason') || '';
  const recent = recentRes.ok ? await recentRes.json() : [];
  if (Array.isArray(recent) && recent.length > 0) return recent;

  // significant=0 нужен, иначе Турбо не попадает в выдачу. Без project нет GPM, XPM и урона по вышкам.
  const project = MATCH_FIELDS.map(f => `project=${f}`).join('&');
  const res = await odFetch(`/players/${accountId}/matches?limit=20&significant=0&${project}`);
  const list = res.ok ? await res.json() : [];
  return Array.isArray(list) ? list : [];
}

function matchRowFromPlayer(match, player) {
  return {
    match_id: match.match_id,
    radiant_win: match.radiant_win,
    duration: match.duration,
    game_mode: match.game_mode,
    lobby_type: match.lobby_type,
    start_time: match.start_time,
    player_slot: player.player_slot,
    hero_id: player.hero_id,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    gold_per_min: player.gold_per_min,
    xp_per_min: player.xp_per_min,
    tower_damage: player.tower_damage,
    last_hits: player.last_hits
  };
}

async function analyzePlayer() {
  const input = document.getElementById('dota-id-input');
  const raw = input ? input.value : '';
  const token = ++scanToken;
  hideScanStates();

  if (!raw.trim()) {
    showError('Нужен ID', 'Вставь ID из Доты, Steam ID или ссылку на свой профиль Steam.');
    return;
  }

  if (/\/match(?:es)?\/\d{6,12}/i.test(raw)) {
    document.getElementById('custom-match-id').value = raw;
    switchTab('replay');
    inspectCustomMatch();
    return;
  }

  setScanning(true, 'Ищу профиль...');

  try {
    const accountId = await resolveAccountId(raw);
    if (token !== scanToken) return;
    if (!accountId) {
      throw new ApiError('Не удалось распознать ID. Подойдут: ник, число из профиля Доты, Steam ID из 17 цифр или ссылка на профиль Steam.');
    }
    if (typeof accountId === 'object') {
      await showNameSearch(accountId.search, token);
      return;
    }

    const pRes = await odFetch(`/players/${accountId}`);
    if (!pRes.ok) throw new ApiError(`OpenDota вернул ошибку ${pRes.status}.`);
    const pData = await pRes.json();
    if (!pData || !pData.profile) throw new ApiError(`Игрок с ID ${accountId} не найден на OpenDota. Проверь число.`);

    setScanning(true, 'Загружаю матчи. Первый раз это может занять до минуты...');
    const matches = await fetchPlayerMatches(accountId);
    if (token !== scanToken) return; // пока шёл запрос, пользователь начал другой скан

    setScanning(false);
    currentAccountId = accountId;
    currentProfile = pData;
    rememberPlayer(accountId);
    currentPlayerName = pData.profile.personaname || 'Игрок';

    if (matches.length > 0) {
      showPlayerResults(pData, matches);
      if (SERVER_MODE) {
        document.getElementById('verdict-text').insertAdjacentHTML('beforeend', `<span class="block mt-2 text-slate-400 text-xs">Источник матчей: ${esc(currentDataSource)}.</span>`);
      }
      return;
    }

    renderNoHistory(pData);
    if (typeof proOnResults === 'function') proOnResults();
  } catch (err) {
    if (token !== scanToken) return;
    setScanning(false);
    showError('Ошибка сканирования', err instanceof ApiError ? err.message : `Не удалось обработать ответ OpenDota: ${err.message}`);
  }
}

function showPlayerResults(profile, matches) {
  currentMatches = matches;
  currentViewerHeroId = matches[0].hero_id;
  currentViewerSlot = matches[0].player_slot;
  currentProfileTier = profile.rank_tier || null;

  hideScanStates();
  const results = document.getElementById('results');
  results.classList.remove('hidden');
  document.body.classList.add('has-results');
  results.classList.add('reveal');
  setTimeout(() => results.classList.remove('reveal'), 800);

  renderPlayerHeader(profile, matches.length);
  renderDashboard(profile, matches);
  renderReplayView(matches[0]);
  if (typeof proOnResults === 'function') proOnResults();
}

async function showNameSearch(query, token) {
  setScanning(true, 'Ищу игрока по нику...');
  const res = await odFetch(`/search?q=${encodeURIComponent(query)}`);
  const list = res.ok ? await res.json() : [];
  if (token !== scanToken) return;
  setScanning(false);

  const players = (Array.isArray(list) ? list : []).slice(0, 8);
  document.getElementById('search-title').textContent = players.length > 0
    ? `Найдено по нику «${query}». Выбери себя:`
    : `По нику «${query}» никого не нашли. Попробуй ID из профиля Доты.`;
  document.getElementById('search-results').innerHTML = players.map(p => `
    <button onclick="fillId('${esc(p.account_id)}')" class="flex items-center gap-3 p-2 rounded-lg text-left border border-slate-800 hover:border-slate-600 transition-colors">
      <img loading="lazy" src="${esc(p.avatarfull || '')}" alt="" class="w-9 h-9 rounded-lg object-cover">
      <span class="min-w-0">
        <span class="block text-sm text-white truncate">${esc(p.personaname || 'Без имени')}</span>
        <span class="block text-xs text-slate-400">ID ${esc(p.account_id)}</span>
      </span>
    </button>
  `).join('');
  document.getElementById('search-state').classList.remove('hidden');
}

function renderNoHistory(pData) {
  const p = pData.profile;
  document.getElementById('nh-name').textContent = p.personaname || `ID ${p.account_id}`;
  const avatar = document.getElementById('nh-avatar');
  avatar.src = p.avatarmedium || '';
  avatar.classList.toggle('hidden', !p.avatarmedium);
  document.getElementById('nh-rank').textContent = pData.rank_tier
    ? `Медаль: ${getRankTitle(pData.rank_tier)}`
    : 'Медаль в OpenDota не указана';
  const reasons = {
    hidden: 'Steam сообщил, что игрок скрыл историю матчей. Посмотреть её можно, только если он сам включит «Общедоступную историю матчей».',
    no_keys: 'На сервере нет ключа Steam и токена STRATZ, поэтому запасные источники выключены.',
    empty: 'Ни один источник не вернул матчи этого игрока.'
  };
  document.getElementById('nh-status').textContent = reasons[currentDataReason] || '';
  document.getElementById('no-history-state').classList.remove('hidden');
  refreshIcons();
}

async function requestProfileRefresh() {
  const status = document.getElementById('nh-status');
  status.textContent = 'Отправляю запрос...';
  try {
    const res = await odFetch(`/players/${currentAccountId}/refresh`, { method: 'POST' });
    status.textContent = res.ok
      ? 'Запрос принят. OpenDota обновит профиль в фоне: подожди несколько минут и нажми «Проверить снова».'
      : `OpenDota отклонил запрос (код ${res.status}).`;
  } catch (e) {
    status.textContent = e.message;
  }
}

// Если профиль пуст, матчи всё равно можно получить по их ID из клиента Доты
async function importMatchesByIds() {
  const status = document.getElementById('nh-status');
  const field = document.getElementById('nh-match-ids');
  const ids = [...new Set(field.value.match(/\d{8,12}/g) || [])].slice(0, 20);
  if (ids.length === 0) {
    status.textContent = 'Вставь хотя бы один Match ID (8–12 цифр).';
    return;
  }

  const rows = [];
  const hidden = [];
  const failed = [];

  for (let i = 0; i < ids.length; i++) {
    status.textContent = `Загружаю матч ${i + 1} из ${ids.length}...`;
    try {
      const res = await odFetch(`/matches/${ids[i]}`);
      const data = res.ok ? await res.json() : null;
      if (!data || !Array.isArray(data.players)) {
        failed.push(ids[i]);
        continue;
      }
      data.__live = true;
      REAL_MATCH_CACHE[data.match_id] = data;
      const player = data.players.find(p => String(p.account_id) === String(currentAccountId));
      if (!player) {
        hidden.push(ids[i]);
        continue;
      }
      rows.push(matchRowFromPlayer(data, player));
    } catch (e) {
      status.textContent = e.message;
      if (rows.length === 0) return;
      break;
    }
  }

  if (rows.length === 0) {
    status.textContent = `Твой аккаунт не найден ни в одном матче. Скрыт в ${hidden.length}, не загружено ${failed.length}.`;
    return;
  }

  rows.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
  showPlayerResults(currentProfile, rows);

  const skipped = [];
  if (hidden.length) skipped.push(`в ${hidden.length} твой аккаунт скрыт`);
  if (failed.length) skipped.push(`${failed.length} не загружено`);
  if (skipped.length) showReplayNotice(`Загружено матчей: ${rows.length}. Пропущено: ${skipped.join(', ')}.`);
}

function showError(title, msg) {
  const box = document.getElementById('error-state');
  document.getElementById('error-title').textContent = title;
  document.getElementById('error-message').textContent = msg;
  box.classList.remove('hidden');
  refreshIcons();
}

// ═══════════════════════════════════════════════════════════════════════
// DEEP TRUE SKILL CALCULATION ENGINE
// ═══════════════════════════════════════════════════════════════════════

function calculatePlayerTrueSkill(matches, officialTier) {
  const coreList = [];
  const suppList = [];

  let sumCoreScore = 0;
  let sumSuppScore = 0;

  // Матчи без GPM оцениваем не по выдуманным значениям, а просто пропускаем
  const scored = pickScoredMatches(matches).filter(m => m.gold_per_min > 0);

  scored.forEach(m => {
    const gpm = m.gold_per_min;
    const td = m.tower_damage ?? 0;
    const deaths = m.deaths ?? 0;
    const kda = ((m.kills || 0) + (m.assists || 0)) / Math.max(1, deaths);

    // Настоящая позиция надёжнее догадки по герою и золоту
    const isSupp = isSupportGame(m);

    if (isSupp) {
      suppList.push(m);
      // Support calculation: KDA, low deaths, assists, support GPM
      const gpmMMR = Math.min(5000, (gpm / 430) * 1800);
      const deathMMR = Math.max(200, (11 - Math.min(10, deaths)) * 360);
      const kdaMMR = Math.min(5000, (kda / 3.0) * 1800);
      const matchMMR = gpmMMR * 0.25 + deathMMR * 0.35 + kdaMMR * 0.4;
      sumSuppScore += matchMMR;
    } else {
      coreList.push(m);
      // Core calculation: GPM, Tower Damage, Survival, KDA
      const gpmMMR = Math.min(6500, (gpm / 550) * 2000);
      const tdMMR = Math.min(6000, (td / 3000) * 1800);
      const deathMMR = Math.max(200, (11 - Math.min(10, deaths)) * 340);
      const kdaMMR = Math.min(5000, (kda / 3.2) * 1800);
      const matchMMR = gpmMMR * 0.35 + tdMMR * 0.25 + deathMMR * 0.2 + kdaMMR * 0.2;
      sumCoreScore += matchMMR;
    }
  });

  const coreCount = coreList.length;
  const suppCount = suppList.length;

  const coreMMR = coreCount > 0 ? Math.round(sumCoreScore / coreCount) : 0;
  const suppMMR = suppCount > 0 ? Math.round(sumSuppScore / suppCount) : 0;

  // Compute performance-based MMR
  let perfMMR = 0;
  if (coreCount > 0 && suppCount > 0) {
    perfMMR = Math.round(coreMMR * 0.65 + suppMMR * 0.35);
  } else if (coreCount > 0) {
    perfMMR = coreMMR;
  } else {
    perfMMR = suppMMR;
  }

  // Official rank anchor
  let finalMMR = perfMMR;
  if (officialTier && officialTier >= 10) {
    const officialBase = rankTierToMMR(officialTier);
    if (officialTier >= 80) {
      // Формула построена на порогах до Героя и у Титанов занижает результат
      finalMMR = officialBase;
    } else if (officialTier <= 15) {
      // На нижних медалях оценка может быть выше медали
      finalMMR = Math.max(officialBase, perfMMR);
    } else {
      // If player is already calibrated (e.g. Archon 5 = 2926 MMR):
      // True Skill accurately reflects form: e.g. ±200 MMR around their true rank
      finalMMR = Math.round(officialBase * 0.75 + perfMMR * 0.25);
    }
  }

  // Core stats averages
  const coreAvgGPM = coreCount > 0 ? Math.round(coreList.reduce((a, b) => a + (b.gold_per_min || 0), 0) / coreCount) : 0;
  const coreAvgTD = coreCount > 0 ? Math.round(coreList.reduce((a, b) => a + (b.tower_damage || 0), 0) / coreCount) : 0;
  const coreAvgKDA = coreCount > 0 ? +(coreList.reduce((a, b) => a + (((b.kills || 0) + (b.assists || 0)) / Math.max(1, b.deaths || 1)), 0) / coreCount).toFixed(2) : 0;

  // Support stats averages
  const suppAvgAssists = suppCount > 0 ? +(suppList.reduce((a, b) => a + (b.assists || 0), 0) / suppCount).toFixed(1) : 0;
  const suppAvgDeaths = suppCount > 0 ? +(suppList.reduce((a, b) => a + (b.deaths || 0), 0) / suppCount).toFixed(1) : 0;
  const suppWins = suppList.filter(m => (m.player_slot < 128 && m.radiant_win) || (m.player_slot >= 128 && !m.radiant_win)).length;
  const suppAvgWR = suppCount > 0 ? Math.round((suppWins / suppCount) * 100) : 0;

  return {
    noData: scored.length === 0,
    trueMMR: Math.max(10, finalMMR),
    trueTier: scored.length > 0 ? mmrToRankTier(finalMMR) : null,
    coreMMR,
    coreTier: coreCount > 0 ? mmrToRankTier(coreMMR) : null,
    suppMMR,
    suppTier: suppCount > 0 ? mmrToRankTier(suppMMR) : null,
    coreMatchesCount: coreCount,
    suppMatchesCount: suppCount,
    coreAvgGPM,
    coreAvgTD,
    coreAvgKDA,
    suppAvgAssists,
    suppAvgDeaths,
    suppAvgWR
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD RENDERING
// ═══════════════════════════════════════════════════════════════════════

function renderDashboard(profile, matches) {
  // Метрики считаем по той же выборке, что и рейтинг: иначе Турбо раздувает GPM
  const statsMatches = pickScoredMatches(matches);
  const count = statsMatches.length;
  const turboExcluded = matches.length - count;
  const allTurbo = matches.every(isTurbo);
  let totalKills = 0, totalDeaths = 0, totalAssists = 0;
  let wins = 0;

  statsMatches.forEach(m => {
    totalKills += (m.kills || 0);
    totalDeaths += (m.deaths || 0);
    totalAssists += (m.assists || 0);

    const isRadiant = m.player_slot < 128;
    const isWin = (isRadiant && m.radiant_win) || (!isRadiant && !m.radiant_win);
    if (isWin) wins++;
  });

  const averageOf = key => {
    const values = statsMatches.map(m => m[key]).filter(v => v != null);
    return values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  };

  const avgGPM = averageOf('gold_per_min');
  const avgXPM = averageOf('xp_per_min');
  const avgDeaths = +(totalDeaths / count).toFixed(1);
  const avgKDA = +((totalKills + totalAssists) / Math.max(1, totalDeaths)).toFixed(2);
  const avgTD = averageOf('tower_damage');
  const winrate = Math.round((wins / count) * 100);

  const officialTier = profile.rank_tier || null;
  const hasRank = officialTier !== null;
  const clientMMR = profile.mmr_estimate ? profile.mmr_estimate.estimate : null;
  const officialMMR = hasRank ? (clientMMR ?? rankTierToMMR(officialTier)) : null;

  // DEEP SKILL CALCULATION
  const skill = calculatePlayerTrueSkill(matches, officialTier);
  currentPlayerTrueMMR = skill.trueMMR;
  currentProfileTier = officialTier;

  // Set Badges
  renderRankBadgeInContainer('official-badge', officialTier, false);
  document.getElementById('official-rank-title').textContent = getRankTitle(officialTier);
  document.getElementById('official-mmr-text').textContent = hasRank
    ? (clientMMR != null
        ? `${officialMMR} ПТС (из клиента)`
        : officialTier >= 80
          ? `от ${officialMMR} ПТС${profile.leaderboard_rank ? ` • #${profile.leaderboard_rank} в таблице` : ''}`
          : `~${officialMMR} ПТС (по медали)`)
    : 'OpenDota не знает медаль';

  renderRankBadgeInContainer('true-badge', skill.trueTier, true);
  document.getElementById('true-rank-title').textContent = getRankTitle(skill.trueTier);
  const trueMmrEl = document.getElementById('true-mmr-text');
  if (skill.noData) {
    trueMmrEl.__animationId = (trueMmrEl.__animationId || 0) + 1;
    trueMmrEl.textContent = 'Нет данных';
  } else {
    animateNumber(trueMmrEl, skill.trueMMR, v => `~${v} ПТС (оценка)`);
  }

  // Gap Badge
  const gap = hasRank && !skill.noData ? skill.trueMMR - officialMMR : null;
  const gapBadge = document.getElementById('gap-badge');
  gapBadge.textContent = gap === null ? 'НЕ С ЧЕМ СРАВНИТЬ' : gap >= 0 ? `+${gap} ПТС К РАНГУ` : `${gap} ПТС`;

  // Deep Verdict Text
  const verdictEl = document.getElementById('verdict-text');
  {
    const rankTitle = getRankTitle(skill.trueTier);
    if (officialTier >= 80) {
      verdictEl.innerHTML = `
        👑 <strong>ТИТАН:</strong> сравнивать не с чем: формула настроена на ранги до Героя, а у Титанов скилл не сводится к GPM и урону по вышкам. Показан официальный ранг.
      `;
    } else if (skill.noData) {
      verdictEl.textContent = 'В этих матчах OpenDota не отдал GPM, поэтому оценить уровень нельзя.';
    } else if (gap === null) {
      verdictEl.innerHTML = `
        📊 <strong>ОЦЕНКА ПО МАТЧАМ:</strong> показатели соответствуют уровню <strong class="text-white">${rankTitle} (~${skill.trueMMR} ПТС)</strong>. Медаль в OpenDota не указана, поэтому сравнить с официальным рангом нельзя.
      `;
    } else if (gap > 400) {
      verdictEl.innerHTML = `
        🔥 <strong>СКРЫТЫЙ СКИЛЛ ОБНАРУЖЕН:</strong> Твой реальный уровень игры — <strong class="text-uc-red">${rankTitle} (~${skill.trueMMR} ПТС)</strong>! Твои показатели фарма (${avgGPM} GPM) и урона по вышкам (${avgTD}) выше текущей медали.
      `;
    } else if (gap < -400) {
      verdictEl.innerHTML = `
        ⚠️ <strong>СПАД ФОРМЫ (ТИЛЬТ):</strong> Твой перформанс в последних матчах (${count}) соответствует рангу <strong class="text-amber-400">${rankTitle} (~${skill.trueMMR} ПТС)</strong>. Смертей за матч: ${avgDeaths}. Что исправить в первую очередь, смотри в разборе ошибок ниже.
      `;
    } else {
      verdictEl.innerHTML = `
        ⚖️ <strong>БЛИЗКО К МЕДАЛИ:</strong> По цифрам твой уровень близок к медали: <strong class="text-white">${rankTitle} (~${skill.trueMMR} ПТС)</strong>. Что поднимет ранг, смотри в разборе ошибок ниже.
      `;
    }
  }

  {
    const notes = [];
    if (count < 5) notes.push(`Всего матчей в оценке: ${count}, для точного вывода нужно хотя бы 10.`);
    if (turboExcluded > 0) notes.push(`Турбо-матчи не учтены (${turboExcluded}): там GPM намного выше обычного.`);
    if (allTurbo) notes.push('Все матчи в Турбо, поэтому оценка завышена.');
    if (notes.length > 0) {
      verdictEl.insertAdjacentHTML('beforeend', `<span class="block mt-2 text-amber-300 text-xs">⚠️ ${esc(notes.join(' '))}</span>`);
    }
  }

  // Populate Role Breakdown Cards
  const coreTierEl = document.getElementById('role-core-tier');
  if (coreTierEl) {
    const hasCore = skill.coreMatchesCount > 0;
    const hasSupp = skill.suppMatchesCount > 0;

    coreTierEl.textContent = hasCore ? getRankTitle(skill.coreTier) : 'Нет игр';
    document.getElementById('role-core-mmr').textContent = hasCore ? `~${skill.coreMMR} ПТС` : '—';
    document.getElementById('role-core-games').textContent = `${skill.coreMatchesCount} матчей`;
    document.getElementById('role-core-gpm').textContent = hasCore ? skill.coreAvgGPM : '—';
    document.getElementById('role-core-td').textContent = hasCore ? skill.coreAvgTD.toLocaleString() : '—';
    document.getElementById('role-core-kda').textContent = hasCore ? skill.coreAvgKDA : '—';
    document.getElementById('role-core-desc').textContent = !hasCore
      ? 'В выборке нет игр на кор-героях.'
      : skill.coreAvgGPM >= 550
        ? 'Фармишь как полноценный керри уровня Рыцарь-Герой. Отличный пуш базы.'
        : 'Средний темп фарма. Сосредоточься на ластхите в первые 10 минут.';

    document.getElementById('role-supp-tier').textContent = hasSupp ? getRankTitle(skill.suppTier) : 'Нет игр';
    document.getElementById('role-supp-mmr').textContent = hasSupp ? `~${skill.suppMMR} ПТС` : '—';
    document.getElementById('role-supp-games').textContent = `${skill.suppMatchesCount} матчей`;
    document.getElementById('role-supp-assists').textContent = hasSupp ? skill.suppAvgAssists : '—';
    document.getElementById('role-supp-deaths').textContent = hasSupp ? skill.suppAvgDeaths : '—';
    document.getElementById('role-supp-wr').textContent = hasSupp ? `${skill.suppAvgWR}%` : '—';
    document.getElementById('role-supp-desc').textContent = !hasSupp
      ? 'В выборке нет игр на саппортах.'
      : skill.suppAvgWR <= 35
        ? 'Низкий винрейт на саппортах. На низком MMR саппорты сильно зависят от рандомных союзников.'
        : 'Хорошее участие в драках и позиционирование.';
  }

  // 6 Metric Cards
  renderMetricCards(avgGPM, avgDeaths, avgKDA, avgTD, avgXPM, winrate, wins, count);

  // 5 Fundamental Pillars Audit
  renderFormChart(matches);
  const audit = buildPlayerAudit(matches, skill);
  renderAudit(audit);
  renderPersonalPlan(audit);

  // Benchmark Table
  renderBenchmarkTable(avgGPM, avgDeaths, avgKDA, avgTD, avgXPM);

  // Hero Grid
  renderHeroGrid(matches);

  // Matches Table
  renderMatchesTable(matches);

  // Radar Chart
  renderRadarChart(matches);

  if (typeof proOnDashboard === 'function') proOnDashboard(profile, matches, skill, audit);

  refreshIcons();
}

// ═══════════════════════════════════════════════════════════════════════
// METRICS & BENCHMARK TABLES
// ═══════════════════════════════════════════════════════════════════════

function renderMetricCards(gpm, deaths, kda, td, xpm, wr, wins, total) {
  const grid = document.getElementById('metrics-grid');
  if (!grid) return;

  const items = [
    {
      icon: 'coins',
      color: 'text-uc-red',
      title: 'ФАРМ (GPM)',
      val: gpm,
      sub: 'Рекрут: 380 • Рыцарь: 530 • Герой: 610',
      tag: gpm >= 610 ? 'Герой' : gpm >= 530 ? 'Рыцарь' : gpm >= 460 ? 'Страж' : 'Рекрут',
      tagClass: gpm >= 530 ? 'bg-uc-red/20 text-uc-red' : 'bg-slate-800 text-slate-300',
      pct: Math.min(100, Math.round((gpm / 750) * 100)),
      desc: 'Скорость добычи золота на линии и в лесу.'
    },
    {
      icon: 'shield',
      color: 'text-emerald-400',
      title: 'ВЫЖИВАЕМОСТЬ',
      val: `${deaths}`,
      sub: 'смертей/матч (Рекрут: 9.5)',
      tag: deaths <= 5.0 ? 'Герой' : deaths <= 6.2 ? 'Рыцарь' : deaths <= 7.8 ? 'Страж' : 'Рекрут',
      tagClass: deaths <= 6.2 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-300',
      pct: Math.max(0, Math.min(100, Math.round((1 - (deaths / 12)) * 100))),
      desc: 'Позиционирование в файтах и отсутствие глупых смертей.'
    },
    {
      icon: 'swords',
      color: 'text-cyan-400',
      title: 'БОЕВОЙ KDA',
      val: kda,
      sub: 'Рекрут: 1.8 • Рыцарь: 3.0 • Герой: 3.7',
      tag: kda >= 3.7 ? 'Герой' : kda >= 3.0 ? 'Рыцарь' : 'Страж',
      tagClass: kda >= 3.0 ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-800 text-slate-300',
      pct: Math.min(100, Math.round((kda / 4.5) * 100)),
      desc: 'Коэффициент убийств и ассистов к смертям.'
    },
    {
      icon: 'castle',
      color: 'text-amber-400',
      title: 'УРОН ВЫШКАМ',
      val: td.toLocaleString(),
      sub: 'Рекрут: 1100 • Рыцарь: 2900 • Герой: 4200',
      tag: td >= 4200 ? 'Герой' : td >= 2900 ? 'Рыцарь' : 'Слабо (Рекрут)',
      tagClass: td >= 2900 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-300',
      pct: Math.min(100, Math.round((td / 4500) * 100)),
      desc: 'Снос строений врага после успешных драк.'
    },
    {
      icon: 'zap',
      color: 'text-purple-400',
      title: 'ТЕМП ОПЫТА (XPM)',
      val: xpm,
      sub: 'Рекрут: 410 • Рыцарь: 610 • Герой: 710',
      tag: xpm >= 710 ? 'Герой' : xpm >= 610 ? 'Рыцарь' : 'Страж',
      tagClass: xpm >= 610 ? 'bg-purple-500/20 text-purple-300' : 'bg-slate-800 text-slate-300',
      pct: Math.min(100, Math.round((xpm / 800) * 100)),
      desc: 'Тайминг получения ультимейта и талантов.'
    },
    {
      icon: 'trophy',
      color: 'text-emerald-400',
      title: 'ВИНРЕЙТ',
      val: `${wr}%`,
      sub: `${wins} побед из ${total} игр`,
      tag: wr >= 55 ? 'Высокий' : wr >= 50 ? 'Стабильно' : 'Зона риска',
      tagClass: wr >= 50 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-300',
      pct: wr,
      desc: `Процент побед за ${total} матчей в оценке.`
    }
  ];

  grid.innerHTML = items.map(it => `
    <div class="glass p-4 rounded-xl space-y-2.5">
      <div class="flex items-center justify-between">
        <span class="text-[13px] font-mono font-bold uppercase text-slate-300 flex items-center gap-1.5">
          <i data-lucide="${it.icon}" class="w-4 h-4 ${it.color}"></i> ${it.title}
        </span>
        <span class="text-xs font-mono font-bold px-2 py-0.5 rounded ${it.tagClass}">${it.tag}</span>
      </div>
      <div class="flex items-baseline justify-between font-mono">
        <span class="text-2xl font-bold text-white stat-big">${it.val}</span>
        <span class="text-xs text-slate-400">${it.sub}</span>
      </div>
      <div class="w-full bg-slate-900/80 h-1.5 rounded-full overflow-hidden">
        <div class="bg-gradient-to-r from-uc-red to-rose-400 h-full rounded-full progress-fill" style="width: ${it.pct}%"></div>
      </div>
      <p class="text-[13px] text-slate-400 leading-tight">${it.desc}</p>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// РАЗБОР ОШИБОК ИГРОКА
// ═══════════════════════════════════════════════════════════════════════

const RANK_STEPS = ['herald', 'guardian', 'crusader', 'archon', 'legend', 'ancient'];
const RANK_STEP_NAMES = { herald: 'Рекрут', guardian: 'Страж', crusader: 'Рыцарь', archon: 'Герой', legend: 'Легенда', ancient: 'Властелин' };

const AUDIT_METRICS = [
  {
    key: 'deaths', field: m => m.deaths ?? 0, lowerIsBetter: true, digits: 1, title: 'Слишком много смертей',
    good: 'Выживаемость',
    fact: (v, t, r) => `В среднем ${v} смертей за матч, у уровня ${r} ориентир до ${t}.`,
    advice: 'Не заходи в чужой лес и на чужую половину, если на карте не видно нескольких врагов. Каждая смерть отдаёт врагу золото и время.'
  },
  {
    key: 'gpm', field: m => m.gold_per_min, digits: 0, title: 'Мало золота',
    good: 'Фарм',
    fact: (v, t, r) => `${v} GPM, у уровня ${r} ориентир от ${t}.`,
    advice: 'Первые 10 минут держи фокус на добивании крипов. После драки возвращайся на пачку, а не стой без дела.'
  },
  {
    key: 'kda', field: m => ((m.kills || 0) + (m.assists || 0)) / Math.max(1, m.deaths ?? 0), digits: 2, title: 'Низкий KDA',
    good: 'KDA',
    fact: (v, t, r) => `KDA ${v}, у уровня ${r} ориентир от ${t}.`,
    advice: 'Заходи в драку вместе с командой и после того, как враги потратили контроль.'
  },
  {
    key: 'towerDamage', field: m => m.tower_damage ?? 0, digits: 0, title: 'Мало урона по вышкам',
    good: 'Снос вышек',
    fact: (v, t, r) => `${v} урона по вышкам за матч, у уровня ${r} ориентир от ${t}.`,
    advice: 'После выигранной драки сразу иди на ближайшую вышку или Рошана. Победа в драке без объекта почти ничего не даёт.'
  },
  {
    key: 'xpm', field: m => m.xp_per_min, digits: 0, title: 'Мало опыта',
    good: 'Опыт',
    fact: (v, t, r) => `${v} XPM, у уровня ${r} ориентир от ${t}.`,
    advice: 'Меньше стой на базе и в ожидании: опыт идёт на линии, в лесу и в драках.'
  }
];

function isSupportGame(m) {
  return m.position ? m.position >= 4 : isHeroSupport(m.hero_id, m.gold_per_min || 0, m.assists || 0, m.kills || 0);
}

function wonMatch(m) {
  return (m.player_slot < 128) === !!m.radiant_win;
}

function average(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function auditTarget(skill) {
  const main = skill.trueTier ? Math.floor(skill.trueTier / 10) : 3;
  return RANK_STEPS[Math.min(RANK_STEPS.length - 1, main)];
}

function buildHeroFindings(scored) {
  const byHero = new Map();
  scored.forEach(m => {
    const hero = byHero.get(m.hero_id) || { id: m.hero_id, games: 0, wins: 0 };
    hero.games += 1;
    if (wonMatch(m)) hero.wins += 1;
    byHero.set(m.hero_id, hero);
  });

  const heroes = [...byHero.values()];
  const findings = [];
  const worst = heroes.filter(h => h.games >= 3 && h.wins / h.games <= 0.34).sort((a, b) => a.wins / a.games - b.wins / b.games)[0];
  const best = heroes.filter(h => h.games >= 3 && h.wins / h.games >= 0.6).sort((a, b) => b.wins / b.games - a.wins / a.games)[0];

  if (worst) {
    findings.push({
      level: 'bad', gap: 0.4, title: `Слабый герой: ${getHeroName(worst.id)}`,
      fact: `${worst.wins} побед из ${worst.games} игр.`,
      advice: 'Сделай паузу на этом герое или разбери на нём 2–3 поражения.'
    });
  }
  if (best) {
    findings.push({
      level: 'good', title: `Сильный герой: ${getHeroName(best.id)}`,
      fact: `${best.wins} побед из ${best.games} игр.`,
      advice: 'Бери его чаще: на знакомом герое проще поднимать ранг.'
    });
  }
  if (scored.length >= 10 && heroes.length / scored.length >= 0.6) {
    findings.push({
      level: 'bad', gap: 0.3, title: 'Слишком много разных героев',
      fact: `${heroes.length} героев за ${scored.length} матчей.`,
      advice: 'Оставь 3–4 героя на своей роли: так быстрее растут механика и понимание таймингов.'
    });
  }
  return findings;
}

function buildHabitFindings(scored) {
  const findings = [];
  const wins = scored.filter(wonMatch);
  const losses = scored.filter(m => !wonMatch(m));

  if (wins.length >= 3 && losses.length >= 3) {
    const winDeaths = average(wins.map(m => m.deaths ?? 0));
    const lossDeaths = average(losses.map(m => m.deaths ?? 0));
    if (lossDeaths - winDeaths >= 2) {
      findings.push({
        level: 'bad', gap: 0.35, title: 'В поражениях резко растут смерти',
        fact: `${lossDeaths.toFixed(1)} смертей в поражениях против ${winDeaths.toFixed(1)} в победах.`,
        advice: 'Когда игра идёт плохо, не пытайся отыграться в одиночку: держись рядом с командой.'
      });
    }
  }

  let streak = 0;
  let longest = 0;
  scored.forEach(m => {
    streak = wonMatch(m) ? 0 : streak + 1;
    longest = Math.max(longest, streak);
  });
  if (longest >= 4) {
    findings.push({
      level: 'bad', gap: 0.25, title: 'Длинная серия поражений',
      fact: `${longest} поражений подряд.`,
      advice: 'После двух поражений подряд делай перерыв минимум на 20 минут.'
    });
  }
  return findings;
}

function buildPlayerAudit(matches, skill) {
  const scored = pickScoredMatches(matches).filter(m => m.gold_per_min > 0);
  if (scored.length < 3) return null;

  const supportGames = scored.filter(isSupportGame);
  const coreGames = scored.filter(m => !isSupportGame(m));
  const isSupportMain = supportGames.length > coreGames.length;
  const roleGames = isSupportMain ? supportGames : coreGames;
  const bench = BENCHMARKS[isSupportMain ? 'support' : 'core'];
  const target = auditTarget(skill);
  const rankName = RANK_STEP_NAMES[target];

  const findings = AUDIT_METRICS.map(metric => {
    // KDA считаем по сумме за все матчи, как в карточке метрик: среднее по матчам завышают игры почти без смертей
    const value = metric.key === 'kda'
      ? roleGames.reduce((sum, m) => sum + (m.kills || 0) + (m.assists || 0), 0) / Math.max(1, roleGames.reduce((sum, m) => sum + (m.deaths || 0), 0))
      : average(roleGames.map(metric.field).filter(v => v != null));
    const goal = bench[metric.key][target];
    const gap = metric.lowerIsBetter ? (value - goal) / goal : (goal - value) / goal;
    const shown = value.toFixed(metric.digits);
    return gap > 0
      ? { level: 'bad', gap, metricKey: metric.key, goal, title: metric.title, fact: metric.fact(shown, goal, rankName), advice: metric.advice }
      : { level: 'good', title: `${metric.good} в норме`, fact: metric.fact(shown, goal, rankName), advice: 'Держи этот уровень.' };
  });

  findings.push(...buildHeroFindings(scored), ...buildHabitFindings(scored));

  const problems = findings.filter(f => f.level === 'bad').sort((a, b) => b.gap - a.gap);
  const strengths = findings.filter(f => f.level === 'good');
  return {
    role: isSupportMain ? 'Поддержка' : 'Кор',
    roleGames: roleGames.length,
    games: scored.length,
    rankName,
    problems,
    strengths,
    progress: buildProgress(scored)
  };
}

function auditCard(item, index) {
  const bad = item.level === 'bad';
  return `
    <div class="glass p-4 rounded-xl border-l-4 ${bad ? 'border-l-uc-red' : 'border-l-emerald-500'} space-y-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-mono font-bold text-white">${esc(item.title)}</span>
        <span class="px-2 py-0.5 rounded text-xs font-mono font-bold whitespace-nowrap ${bad ? 'bg-uc-red/20 text-uc-red' : 'bg-emerald-500/20 text-emerald-400'}">${bad ? `Ошибка #${index + 1}` : 'Сильная сторона'}</span>
      </div>
      <p class="text-xs text-slate-300">${esc(item.fact)}</p>
      <p class="text-xs text-slate-400 leading-relaxed pt-1 border-t border-slate-800/80">${esc(item.advice)}</p>
    </div>`;
}

let formChartInstance = null;

// IMP показывает вклад относительно других игроков на этой роли, поэтому годится для сравнения матчей между собой
function renderFormChart(matches) {
  const card = document.getElementById('form-card');
  const rows = matches.filter(m => m.imp != null).slice().reverse();
  if (!card) return;
  card.classList.toggle('hidden', rows.length < 3);
  if (rows.length < 3) return;

  const half = Math.floor(rows.length / 2);
  const older = average(rows.slice(0, half).map(m => m.imp));
  const recent = average(rows.slice(half).map(m => m.imp));
  const delta = Math.round(recent - older);
  document.getElementById('form-note').textContent = delta >= 3
    ? `Форма растёт: вклад в последних матчах выше на ${delta} пунктов IMP.`
    : delta <= -3
      ? `Форма падает: вклад в последних матчах ниже на ${Math.abs(delta)} пунктов IMP.`
      : 'Форма ровная: вклад в матчах почти не меняется.';

  if (typeof Chart === 'undefined') return;
  if (formChartInstance) formChartInstance.destroy();
  formChartInstance = new Chart(document.getElementById('form-chart'), {
    type: 'line',
    data: {
      labels: rows.map(m => getHeroName(m.hero_id)),
      datasets: [{ data: rows.map(m => m.imp), borderColor: '#F0444F', backgroundColor: 'rgba(240,68,79,.12)', fill: true, tension: .3, pointRadius: 3 }]
    },
    options: {
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false } },
        y: { ticks: { color: '#A3ACBB' }, grid: { color: 'rgba(255,255,255,.06)' } }
      }
    }
  });
}

function buildProgress(scored) {
  if (scored.length < 10) return '';
  const recent = scored.slice(0, 5);
  const earlier = scored.slice(5);
  const before = average(earlier.map(m => m.deaths ?? 0));
  const now = average(recent.map(m => m.deaths ?? 0));
  const diff = before - now;
  if (Math.abs(diff) < 1) return `Смерти за матч почти не меняются: ${now.toFixed(1)} в последних 5 играх.`;
  return diff > 0
    ? `Прогресс: в последних 5 играх смертей меньше, ${now.toFixed(1)} против ${before.toFixed(1)} раньше.`
    : `Стало хуже: в последних 5 играх смертей больше, ${now.toFixed(1)} против ${before.toFixed(1)} раньше.`;
}

function renderAudit(audit) {
  const container = document.getElementById('five-pillars-grid');
  if (!container) return;
  if (!audit) {
    container.innerHTML = '<p class="text-sm text-slate-400">Для разбора ошибок нужно хотя бы 3 матча с данными.</p>';
    return;
  }
  const note = `<p class="sm:col-span-2 lg:col-span-3 text-xs text-slate-400">Основная роль: ${esc(audit.role)} (${audit.roleGames} из ${audit.games} матчей). Сравнение с ориентирами уровня ${esc(audit.rankName)}: это следующая ступень после твоей оценки. Ориентиры примерные.</p>`;
  const empty = audit.problems.length === 0 ? '<p class="sm:col-span-2 lg:col-span-3 text-sm text-emerald-400">По цифрам явных ошибок нет.</p>' : '';
  const main = audit.problems.slice(0, 3);
  const others = [...audit.problems.slice(3), ...audit.strengths];
  const offset = main.length;
  const more = others.length > 0
    ? `<details class="audit-more"><summary>Показать ещё (${others.length})</summary><div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3">${others.map((item, i) => auditCard(item, i + offset)).join('')}</div></details>`
    : '';
  container.innerHTML = note + empty + main.map(auditCard).join('') + more;
}

function renderPersonalPlan(audit) {
  const box = document.getElementById('personal-plan');
  if (!box) return;
  if (!audit || audit.problems.length === 0) {
    box.innerHTML = audit
      ? '<p class="text-sm text-emerald-400">По цифрам явных ошибок нет. Выбери из общего плана ниже то, что хочешь подтянуть.</p>'
      : '<p class="text-sm text-slate-400">Введи свой ID на вкладке «Профиль», и здесь появится твой план на ближайшие игры.</p>';
    return;
  }
  box.innerHTML = `
    <p class="text-sm text-slate-300">${esc(currentPlayerName)}, на ближайшие 10 игр сосредоточься на этом:</p>
    ${audit.progress ? `<p class="text-sm text-amber-300">${esc(audit.progress)}</p>` : ''}
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">${audit.problems.slice(0, 3).map(auditCard).join('')}</div>`;
}

function renderBenchmarkTable(gpm, deaths, kda, td, xpm) {
  const tbody = document.getElementById('bench-tbody');
  if (!tbody) return;

  const rows = [
    { name: 'Фарм золота (GPM)', val: gpm, h: '380', g: '460', c: '530', a: '610', tier: gpm >= 610 ? 'Герой (Archon)' : gpm >= 530 ? 'Рыцарь (Crusader)' : gpm >= 460 ? 'Страж' : 'Рекрут' },
    { name: 'Смертей за матч', val: deaths, h: '9.5', g: '7.8', c: '6.2', a: '5.0', tier: deaths <= 5.0 ? 'Герой' : deaths <= 6.2 ? 'Рыцарь' : deaths <= 7.8 ? 'Страж' : 'Рекрут' },
    { name: 'Боевой KDA', val: kda, h: '1.8', g: '2.4', c: '3.0', a: '3.7', tier: kda >= 3.7 ? 'Герой' : kda >= 3.0 ? 'Рыцарь+' : 'Страж' },
    { name: 'Урон по вышкам', val: td.toLocaleString(), h: '1,100', g: '1,900', c: '2,900', a: '4,200', tier: td >= 2900 ? 'Рыцарь' : 'Рекрут!' },
    { name: 'Темп опыта (XPM)', val: xpm, h: '410', g: '510', c: '610', a: '710', tier: xpm >= 710 ? 'Герой' : xpm >= 610 ? 'Рыцарь' : 'Страж' }
  ];

  tbody.innerHTML = rows.map(r => `
    <tr class="hover:bg-slate-800/30 transition-colors">
      <td class="px-3 py-2.5 font-medium text-white">${r.name}</td>
      <td class="px-3 py-2.5 font-bold text-uc-red bg-uc-red/10">${r.val}</td>
      <td class="px-3 py-2.5 text-slate-400">${r.h}</td>
      <td class="px-3 py-2.5 text-slate-400">${r.g}</td>
      <td class="px-3 py-2.5 text-amber-300 font-semibold">${r.c}</td>
      <td class="px-3 py-2.5 text-cyan-300">${r.a}</td>
      <td class="px-3 py-2.5 text-right font-semibold ${r.tier.includes('Герой') ? 'text-cyan-400' : r.tier.includes('Рыцарь') ? 'text-uc-red' : r.tier.includes('Рекрут') ? 'text-rose-400' : 'text-slate-300'}">
        ${r.tier}
      </td>
    </tr>
  `).join('');
}

function renderHeroGrid(matches) {
  const grid = document.getElementById('hero-grid');
  if (!grid) return;

  const map = {};
  pickScoredMatches(matches).forEach(m => {
    if (!map[m.hero_id]) map[m.hero_id] = { id: m.hero_id, games: 0, wins: 0, gpm: 0, deaths: 0 };
    map[m.hero_id].games++;
    const isWin = (m.player_slot < 128 && m.radiant_win) || (m.player_slot >= 128 && !m.radiant_win);
    if (isWin) map[m.hero_id].wins++;
    map[m.hero_id].gpm += (m.gold_per_min || 0);
    map[m.hero_id].deaths += (m.deaths || 0);
  });

  const sorted = Object.values(map).sort((a, b) => b.games - a.games).slice(0, 4);

  grid.innerHTML = sorted.map(h => {
    const icon = getHeroIcon(h.id);
    const name = getHeroName(h.id);
    const wr = Math.round((h.wins / h.games) * 100);
    const avgG = Math.round(h.gpm / h.games);
    const avgD = +(h.deaths / h.games).toFixed(1);

    // Realistic Hero MMR Calculation
    let heroMMR = Math.round(avgG * 3.4 - avgD * 60 + (wr - 50) * 14 + 350);
    const heroTier = mmrToRankTier(Math.max(100, heroMMR));
    const tierName = getRankTitle(heroTier);
    const isHigh = heroTier >= 30;

    return `
      <div class="glass p-3.5 rounded-xl space-y-2.5 hover:border-uc-red/40 transition-colors">
        <div class="flex items-center gap-3">
          <img loading="lazy" decoding="async" src="${icon}" alt="${name}" class="w-12 h-7 object-cover hero-icon border border-slate-700">
          <div class="overflow-hidden">
            <h5 class="font-outfit font-bold text-white text-xs truncate">${name}</h5>
            <span class="text-xs text-slate-400 font-mono">${h.games} игр • ${wr}% WR</span>
          </div>
        </div>
        <div class="pt-1.5 border-t border-slate-800/80 flex items-center justify-between text-[13px] font-mono">
          <span class="text-slate-400">Уровень:</span>
          <span class="${isHigh ? 'text-uc-red font-bold' : 'text-slate-300'}">${tierName}</span>
        </div>
        <div class="grid grid-cols-2 gap-1.5 text-xs font-mono text-center">
          <div class="p-1 rounded bg-black/50 text-uc-red">${avgG} GPM</div>
          <div class="p-1 rounded bg-black/50 text-slate-300">${avgD} смертей</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderMatchesTable(matches) {
  const tbody = document.getElementById('matches-tbody');
  if (!tbody) return;

  tbody.innerHTML = matches.map((m, idx) => {
    const isWin = (m.player_slot < 128 && m.radiant_win) || (m.player_slot >= 128 && !m.radiant_win);
    const icon = getHeroIcon(m.hero_id);
    const name = getHeroName(m.hero_id);

    const rank = matchRank(m);
    const matchTier = rank ? rank.title : isTurbo(m) ? 'Турбо' : '—';
    const rankColor = !rank ? 'text-slate-400' : rank.tone === 'up' ? 'text-emerald-400' : rank.tone === 'down' ? 'text-rose-400' : 'text-amber-300';

    return `
      <tr class="hover:bg-slate-800/30 transition-colors">
        <td class="px-3 py-2.5 flex items-center gap-2">
          <img loading="lazy" decoding="async" src="${icon}" alt="${name}" class="w-8 h-5 object-cover hero-icon">
          <span class="font-medium text-white">${name}</span>
        </td>
        <td class="px-3 py-2.5 font-mono">
          <span class="px-2 py-0.5 rounded text-xs font-bold ${isWin ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}">
            ${isWin ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'}
          </span>
        </td>
        <td class="px-3 py-2.5 font-mono text-[13px]">
          <span class="text-emerald-400 font-bold">${m.kills || 0}</span> /
          <span class="text-rose-400 font-bold">${m.deaths || 0}</span> /
          <span class="text-slate-400">${m.assists || 0}</span>
        </td>
        <td class="px-3 py-2.5 font-mono text-uc-red font-semibold">${formatStat(m.gold_per_min)}</td>
        <td class="px-3 py-2.5 font-mono text-slate-300">${formatStat(m.tower_damage)}</td>
        <td class="px-3 py-2.5 font-mono text-[13px] ${rankColor} font-semibold whitespace-nowrap">${matchTier}</td>
        <td class="px-3 py-2.5 text-center">
          <button onclick="inspectMatchIndex(${idx})" class="px-3 py-1 bg-uc-red/15 hover:bg-uc-red text-uc-red hover:text-white border border-uc-red/30 rounded-lg text-[13px] font-bold font-mono transition-colors">
            РАЗБОР
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// RADAR CHART (CHART.JS)
// ═══════════════════════════════════════════════════════════════════════

function radarScores(games) {
  const kills = games.reduce((sum, m) => sum + (m.kills || 0), 0);
  const assists = games.reduce((sum, m) => sum + (m.assists || 0), 0);
  const deaths = games.reduce((sum, m) => sum + (m.deaths || 0), 0);
  const gpm = average(games.map(m => m.gold_per_min || 0));
  const xpm = average(games.map(m => m.xp_per_min || 0));
  const td = average(games.map(m => m.tower_damage || 0));
  const wins = games.filter(wonMatch).length;
  return [
    Math.min(100, Math.round((gpm / 680) * 100)),
    Math.max(0, Math.min(100, Math.round((1 - (deaths / games.length / 12)) * 100))),
    Math.min(100, Math.round((((kills + assists) / Math.max(1, deaths)) / 4) * 100)),
    Math.min(100, Math.round((td / 4200) * 100)),
    Math.min(100, Math.round((xpm / 750) * 100)),
    Math.round((wins / games.length) * 100)
  ];
}

// Сравниваем игрока с ним самим: новые игры против старых. Эталонов рангов с точными цифрами у нас нет.
function renderRadarChart(matches) {
  const canvas = document.getElementById('radar-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (radarChartInstance) {
    radarChartInstance.destroy();
  }

  const games = pickScoredMatches(matches).filter(m => m.gold_per_min > 0);
  if (games.length === 0) return;
  const half = Math.floor(games.length / 2);
  const hasProgress = games.length >= 6;
  const recent = hasProgress ? games.slice(0, half) : games;
  const older = hasProgress ? games.slice(half) : [];
  const note = document.getElementById('radar-note');
  if (note) {
    note.textContent = hasProgress
      ? `Чем дальше от центра, тем лучше. Красным ${recent.length} последних игр, серым ${older.length} игр до них.`
      : 'Чем дальше от центра, тем лучше. Для сравнения с прошлыми играми нужно хотя бы 6 матчей.';
  }

  radarChartInstance = new Chart(canvas, {
    type: 'radar',
    data: {
      labels: ['Фарм (GPM)', 'Выживаемость', 'KDA', 'Снос вышек', 'Опыт (XPM)', 'Винрейт'],
      datasets: [
        {
          label: 'Последние игры',
          data: radarScores(recent),
          backgroundColor: 'rgba(255, 42, 66, 0.25)',
          borderColor: '#FF2A42',
          pointBackgroundColor: '#FF2A42',
          borderWidth: 2
        },
        ...(older.length > 0 ? [{
          label: 'Игры до них',
          data: radarScores(older),
          backgroundColor: 'rgba(100, 116, 139, 0.12)',
          borderColor: '#94A3B8',
          pointBackgroundColor: '#94A3B8',
          borderWidth: 1.5,
          borderDash: [4, 4]
        }] : [])
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { display: false },
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
          angleLines: { color: 'rgba(255, 255, 255, 0.08)' },
          pointLabels: {
            color: '#94A3B8',
            font: { family: 'Inter', size: 11, weight: '600' }
          }
        }
      },
      plugins: {
        legend: {
          labels: {
            color: '#CBD5E1',
            font: { family: 'Inter', size: 11 }
          }
        }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// SHOWCASE TAB (INTERACTIVE MOCKUP)
// ═══════════════════════════════════════════════════════════════════════

const SHOWCASE_ITEMS = {
  'true-mmr': {
    title: 'True MMR Scanner',
    btnDesc: 'Расчёт скрытого ПТС на основе эффективности фарма и урона',
    html: `
      <div class="glass p-5 rounded-xl space-y-4">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-400 font-mono">[АЛГОРИТМ TRUE SKILL]</span>
          <span class="text-xs text-amber-400 font-mono font-bold">ПРИМЕР</span>
        </div>
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-xl bg-uc-red/20 border border-uc-red/40 flex items-center justify-center text-uc-red font-black text-xl">D2</div>
          <div>
            <h4 class="text-lg font-outfit font-bold text-white">Рыцарь 2 (Crusader)</h4>
            <p class="text-xs font-mono text-uc-red font-bold">~1750 РАСЧЁТНЫЙ ПТС</p>
          </div>
        </div>
        <p class="text-xs text-slate-400 leading-relaxed">
          Исключает фактор тиммейтов-руинеров. Оценивает чистые действия игрока: ластхит крипов на 10-й минуте, урон по строениям и смерти без байбека.
        </p>
      </div>
    `
  },
  'replay-coach': {
    title: 'AI Replay Coach',
    btnDesc: 'Поминутный разбор каждой смерти с советами и таймингами',
    html: `
      <div class="glass p-4 rounded-xl space-y-2 font-mono text-xs">
        <div class="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 flex justify-between">
          <span>⏱️ 18:40 [ТЕМНОТА]</span>
          <span class="font-bold text-uc-red">Смерть в соло (-700G)</span>
        </div>
        <div class="p-2.5 rounded-lg bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 flex justify-between">
          <span>⏱️ 26:10 [АЙТЕМЫ]</span>
          <span class="font-bold text-cyan-400">Нет BKB в драке на Рошане</span>
        </div>
        <div class="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 flex justify-between">
          <span>⏱️ 34:50 [МАКРО]</span>
          <span class="font-bold text-emerald-400">Рекомендован снос Т3 вместо леса</span>
        </div>
      </div>
    `
  },
  'hero-matrix': {
    title: 'Hero Efficiency Matrix',
    btnDesc: 'Ранг на каждом персонаже — выявление героев для спама',
    html: `
      <div class="grid grid-cols-2 gap-3 font-mono text-xs">
        <div class="glass p-3.5 rounded-xl border-emerald-500/30">
          <div class="font-bold text-white">Arc Warden</div>
          <div class="text-emerald-400 font-bold mt-1">Рыцарь 3 (~1850 ПТС)</div>
          <div class="text-xs text-slate-400 mt-0.5">66% WR • 710 GPM • Спамь!</div>
        </div>
        <div class="glass p-3.5 rounded-xl border-rose-500/30">
          <div class="font-bold text-white">Keeper of the Light</div>
          <div class="text-rose-400 font-bold mt-1">Рекрут 1 (~100 ПТС)</div>
          <div class="text-xs text-slate-400 mt-0.5">25% WR • 4 игры • Не бери!</div>
        </div>
      </div>
    `
  },
  'anchor-detect': {
    title: 'Fatal Anchor Detector',
    btnDesc: 'Выявление главной систематической ошибки, стопорящей ранг',
    html: `
      <div class="glass p-5 rounded-xl border-uc-red/30 space-y-2">
        <div class="text-[13px] font-mono font-bold text-uc-red">[ФАТАЛЬНЫЙ ЯКОРЬ НАЙДЕН]</div>
        <h5 class="text-white font-bold text-sm">Игнорирование вышек после тимфайтов</h5>
        <p class="text-xs text-slate-400 leading-relaxed">
          Вместо пуша бараков ты уходишь бить лесных крипов. Это даёт вражескому керри время возродиться и камбекнуть.
        </p>
      </div>
    `
  }
};

function renderShowcaseButtons() {
  const container = document.getElementById('showcase-buttons');
  if (!container) return;

  container.innerHTML = Object.keys(SHOWCASE_ITEMS).map(k => `
    <button
      id="btn-sc-${k}"
      onclick="selectShowcase('${k}')"
      class="w-full text-left p-3.5 rounded-xl glass border transition-colors flex items-start gap-3"
    >
      <div class="w-8 h-8 rounded-lg bg-uc-red/15 text-uc-red flex items-center justify-center font-bold flex-shrink-0 text-xs">
        TS
      </div>
      <div>
        <h5 class="font-outfit font-bold text-xs text-white">${SHOWCASE_ITEMS[k].title}</h5>
        <p class="text-[13px] text-slate-400 mt-0.5 leading-snug">${SHOWCASE_ITEMS[k].btnDesc}</p>
      </div>
    </button>
  `).join('');
}

function selectShowcase(key) {
  Object.keys(SHOWCASE_ITEMS).forEach(k => {
    const btn = document.getElementById(`btn-sc-${k}`);
    if (btn) {
      if (k === key) {
        btn.className = 'w-full text-left p-3.5 rounded-xl glass border-uc-red/50 text-white shadow-lg transition-colors flex items-start gap-3';
      } else {
        btn.className = 'w-full text-left p-3.5 rounded-xl glass border-transparent text-slate-400 hover:text-white transition-colors flex items-start gap-3';
      }
    }
  });

  const item = SHOWCASE_ITEMS[key];
  if (!item) return;

  document.getElementById('showcase-title').textContent = item.title;
  document.getElementById('showcase-content').innerHTML = item.html;
}

// ═══════════════════════════════════════════════════════════════════════
// REPLAY COACH 3.0: WHO WON/LOST THE GAME & DETAILED BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════

function inspectMatchIndex(idx) {
  const match = currentMatches[idx];
  if (!match) return;

  currentActiveReplayMatch = match;
  switchTab('replay');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderReplayView(match); // сам показывает загрузку и подтягивает 10 игроков
}

function showReplayNotice(text) {
  const box = document.getElementById('rp-notice');
  if (!box) return;
  box.textContent = text || '';
  box.classList.toggle('hidden', !text);
}

// Номер матча или ссылка на него с Dotabuff, OpenDota и STRATZ
function extractMatchId(raw) {
  const text = String(raw || '').trim();
  if (/^\d{6,12}$/.test(text)) return text;
  const found = text.match(/\/match(?:es)?\/(\d{6,12})/i);
  return found ? found[1] : '';
}

async function inspectCustomMatch() {
  const input = document.getElementById('custom-match-id');
  const matchId = input ? extractMatchId(input.value) : '';
  if (!matchId) {
    showReplayNotice('Вставь номер матча или ссылку на него с Dotabuff, OpenDota или STRATZ.');
    return;
  }
  if (input) input.value = matchId;

  const loading = document.getElementById('replay-loading');
  const container = document.getElementById('replay-container');
  showReplayNotice('');
  loading.classList.remove('hidden');
  container.classList.add('hidden');

  try {
    const res = await odFetch(`/matches/${matchId}`);
    const data = res.ok ? await res.json() : null;
    if (!data || !Array.isArray(data.players) || data.players.length === 0) {
      throw new ApiError(`Матч ${matchId} не найден на OpenDota.`);
    }

    data.__live = true;
    REAL_MATCH_CACHE[data.match_id] = data;

    const mine = data.players.find(p => currentAccountId && String(p.account_id) === String(currentAccountId));
    const player = mine || data.players[0];
    renderReplayView({
      match_id: data.match_id,
      hero_id: player.hero_id,
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      gold_per_min: player.gold_per_min,
      xp_per_min: player.xp_per_min,
      tower_damage: player.tower_damage,
      radiant_win: data.radiant_win,
      player_slot: player.player_slot,
      duration: data.duration,
      game_mode: data.game_mode
    });
    if (!mine) {
      showReplayNotice(`Твоего аккаунта нет в этом матче (или он скрыт), поэтому показан игрок из первого слота: ${getHeroName(player.hero_id)}.`);
    }
  } catch (e) {
    showReplayNotice(e instanceof ApiError ? e.message : 'Не удалось разобрать ответ OpenDota.');
  } finally {
    loading.classList.add('hidden');
    container.classList.remove('hidden');
  }
}

function applyMatchGrade(m) {
  const live = getLiveMatchData(m);
  const detail = live ? playerDetail(live.match, live.player) : null;
  if (!detail || detail.imp == null) return;
  const rank = matchRank({ ...m, imp: detail.imp });
  document.getElementById('rp-grade').textContent = `${rank.title} (~${rank.mmr} ПТС)`;
  document.getElementById('rp-grade-sub').textContent = `Вклад в матч (IMP): ${detail.imp > 0 ? '+' : ''}${detail.imp}`;
}

function renderReplayDetails(m, isWin) {
  applyMatchGrade(m);
  renderMatchStory(m, isWin);
  renderPhases(m);
  renderMatchMistakes(m);
  renderLiveDeaths(m);
  renderHeroSpecificTips(m.hero_id);
  renderActiveProModule(currentActiveProModule, m);
  if (typeof proOnReplay === 'function') proOnReplay(m);
  refreshIcons();
}

function renderReplayView(m) {
  const heroName = getHeroName(m.hero_id);
  const heroIcon = getHeroIcon(m.hero_id);
  const isWin = (m.player_slot < 128 && m.radiant_win) || (m.player_slot >= 128 && !m.radiant_win);

  showReplayNotice('');
  const replayBox = document.getElementById('replay-container');
  replayBox.classList.remove('fade-swap');
  void replayBox.offsetWidth; // перезапускает анимацию при смене матча
  replayBox.classList.add('fade-swap');
  document.getElementById('rp-hero-img').src = heroIcon;
  document.getElementById('rp-hero-name').textContent = heroName;
  document.getElementById('rp-match-id').textContent = `Матч #${m.match_id}`;

  const resEl = document.getElementById('rp-result');
  resEl.textContent = isWin ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
  resEl.className = `px-2 py-0.5 rounded text-[13px] font-bold font-mono ${isWin ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`;

  document.getElementById('rp-kda').textContent = `${m.kills ?? 0} / ${m.deaths ?? 0} / ${m.assists ?? 0}`;
  document.getElementById('rp-gpm').textContent = `${formatStat(m.gold_per_min)} / ${formatStat(m.xp_per_min)}`;
  document.getElementById('rp-td').textContent = formatStat(m.tower_damage);

  const evalResult = calculateMatchPerformanceGrade(m, isWin, currentProfileTier, currentPlayerTrueMMR);
  const rank = matchRank(m);
  document.getElementById('rp-grade').textContent = rank ? `${rank.title} (~${rank.mmr} ПТС)` : 'Турбо';
  document.getElementById('rp-grade-sub').textContent = isTurbo(m)
    ? 'В Турбо GPM намного выше обычного, поэтому шкала рангов здесь не применяется'
    : evalResult.sub;

  renderReplayPills(m.match_id);

  currentActiveReplayMatch = m;
  renderReplayDetails(m, isWin);

  loadItemNames();

  // Подгружаем всех 10 игроков
  const cached = REAL_MATCH_CACHE[m.match_id];
  if (m.match_id && !(cached && cached.__live)) {
    odFetch(`/matches/${m.match_id}`)
      .then(res => res.ok ? res.json() : null)
      .catch(() => null)
      .then(matchData => {
        if (matchData && Array.isArray(matchData.players) && matchData.players.length >= 10) {
          matchData.__live = true;
          REAL_MATCH_CACHE[m.match_id] = matchData;
        } else if (!cached) {
          m.__fetchFailed = true;
        }
        if (currentActiveReplayMatch && currentActiveReplayMatch.match_id === m.match_id) {
          renderReplayDetails(m, isWin);
        }
      });
  }
}

function renderReplayPills(activeMatchId) {
  const container = document.getElementById('rp-match-pills');
  if (!container) return;
  container.innerHTML = currentMatches.map((m, idx) => {
    const heroName = getHeroName(m.hero_id);
    const heroIcon = getHeroIcon(m.hero_id);
    const isWin = (m.player_slot < 128 && m.radiant_win) || (m.player_slot >= 128 && !m.radiant_win);
    const isActive = activeMatchId ? (m.match_id === activeMatchId) : (idx === 0);
    const borderClass = isActive
      ? (isWin ? 'border-emerald-500 bg-emerald-500/20 shadow-md shadow-emerald-500/20' : 'border-uc-red bg-uc-red/20 shadow-md shadow-uc-red/20')
      : 'border-slate-800/80 bg-black/40 hover:border-slate-600';
    const tag = isWin ? 'ПОБЕДА' : 'СЛИВ';
    const tagColor = isWin ? 'text-emerald-400' : 'text-rose-400';

    return `
      <button onclick="inspectMatchIndex(${idx})" class="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-xl border ${borderClass} transition-colors text-left">
        <img loading="lazy" decoding="async" src="${heroIcon}" alt="${heroName}" class="w-8 h-5 object-cover rounded border border-slate-700">
        <div>
          <div class="text-[13px] font-bold text-white flex items-center gap-1.5">
            <span>${heroName}</span>
            <span class="text-xs font-mono font-bold ${tagColor}">[${tag}]</span>
          </div>
          <div class="text-xs font-mono text-slate-400">
            ${m.kills}/${m.deaths}/${m.assists} • ${(m.tower_damage || 0).toLocaleString()} TD
          </div>
        </div>
      </button>
    `;
  }).join('');
}

function formatMatchDuration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ═══════════════════════════════════════════════════════════════════════
// REAL 10-PLAYER MATCH CACHE & DYNAMIC EVALUATOR
// ═══════════════════════════════════════════════════════════════════════

// Матчи, загруженные за эту сессию
const REAL_MATCH_CACHE = {};

function buildStoryFromRealMatch(realMatch, viewerHeroId, viewerSlot) {
  const viewerSlotNum = (viewerSlot != null) ? Number(viewerSlot) : null;
  let viewer = null;
  if (viewerSlotNum != null) {
    viewer = realMatch.players.find(p => p.player_slot === viewerSlotNum);
  }
  if (!viewer && viewerHeroId) {
    viewer = realMatch.players.find(p => p.hero_id === viewerHeroId);
  }
  if (!viewer) {
    viewer = realMatch.players[0] || {};
  }

  const isRadiant = viewer.player_slot < 128;
  const isWin = (isRadiant && realMatch.radiant_win) || (!isRadiant && !realMatch.radiant_win);
  const allies = realMatch.players.filter(p => (p.player_slot < 128) === isRadiant);
  const enemies = realMatch.players.filter(p => (p.player_slot < 128) !== isRadiant);

  // Rate every ally
  allies.forEach(a => {
    const k = a.kills || 0;
    const d = a.deaths || 0;
    const as = a.assists || 0;
    const td = a.tower_damage || 0;
    const gpm = a.gold_per_min || 0;
    a.calcImpact = (k * 3.5) + (as * 1.5) + (td * 0.003) + (gpm * 0.015) - (d * 2.5);
    a.calcRuin = (d * 4.0) + Math.max(0, (650 - gpm) * 0.03) - (k * 2.0) - (as * 1.0) - (td * 0.003);
  });

  // Rate enemies
  enemies.forEach(e => {
    const k = e.kills || 0;
    const d = e.deaths || 0;
    const as = e.assists || 0;
    const td = e.tower_damage || 0;
    const gpm = e.gold_per_min || 0;
    e.calcImpact = (k * 3.5) + (as * 1.5) + (td * 0.003) + (gpm * 0.015) - (d * 2.5);
    e.calcRuin = (d * 4.0) + Math.max(0, (650 - gpm) * 0.03) - (k * 2.0) - (as * 1.0) - (td * 0.003);
  });

  // Если у всей команды есть настоящий IMP от STRATZ, ранжируем по нему, а не по своей формуле.
  [allies, enemies].forEach(team => {
    const imps = team.map(p => {
      const detail = playerDetail(realMatch, p);
      return detail && typeof detail.imp === 'number' ? detail.imp : null;
    });
    if (imps.length > 0 && imps.every(imp => imp !== null)) {
      team.forEach((p, i) => { p.calcImpact = imps[i]; p.calcRuin = -imps[i]; });
    }
  });

  const sortedAlliesByImpact = [...allies].sort((a, b) => b.calcImpact - a.calcImpact);
  const sortedAlliesByRuin = [...allies].sort((a, b) => b.calcRuin - a.calcRuin);
  const sortedEnemiesByImpact = [...enemies].sort((a, b) => b.calcImpact - a.calcImpact);
  const sortedEnemiesByRuin = [...enemies].sort((a, b) => b.calcRuin - a.calcRuin);

  const topAllyMvp = sortedAlliesByImpact[0] || allies[0];
  const topAllyRuiner = sortedAlliesByRuin[0] || allies[0];
  const topEnemyThreat = sortedEnemiesByImpact[0] || enemies[0];
  const topEnemyRuiner = sortedEnemiesByRuin[0] || enemies[0];

  const durationStr = formatMatchDuration(realMatch.duration);
  const viewerHeroName = getHeroName(viewer.hero_id);
  const positions = assignTeamPositions(allies);

  // Format allies for grid
  const formattedTeammates = allies.map((a, idx) => {
    const isThisViewer = (a.player_slot === viewer.player_slot);
    const heroName = getHeroName(a.hero_id);
    const isTopMvp = (a.player_slot === topAllyMvp.player_slot);
    const isWorstRuiner = (a.player_slot === topAllyRuiner.player_slot);
    const allyRank = sortedAlliesByImpact.findIndex(p => p.player_slot === a.player_slot) + 1;

    // Номер слота не равен позиции на карте: подпись берём из assignTeamPositions
    let rolePrefix = positions.labels.get(a.player_slot) || `Игрок ${a.player_slot % 128 + 1}`;
    if (isThisViewer) rolePrefix += ' (Ты)';

    let tag = `${allyRank}-е место`;
    let tagClass = 'bg-slate-800 text-slate-300';
    if (isWin) {
      if (allyRank === 1) { tag = '👑 ТОП-1 MVP'; tagClass = 'bg-uc-red/20 text-uc-red font-bold'; }
      else if (allyRank === 2) { tag = '🥈 2-Е МЕСТО'; tagClass = 'bg-emerald-500/20 text-emerald-400 font-bold'; }
      else if (allyRank === 3) { tag = '🥉 3-Е МЕСТО'; tagClass = 'bg-emerald-500/20 text-emerald-400 font-bold'; }
      else if ((a.tower_damage || 0) >= 2500) { tag = '🏰 ПУШЕР ВЫШЕК'; tagClass = 'bg-cyan-500/20 text-cyan-400 font-bold'; }
      else { tag = '🛡️ САППОРТ'; tagClass = 'bg-emerald-500/20 text-emerald-400'; }
    } else {
      if (isWorstRuiner) { tag = '🛑 ГЛАВНЫЙ РУИНЕР'; tagClass = 'bg-rose-500/20 text-rose-400 font-bold'; }
      else if (allyRank === 1) { tag = '👑 СОЛО ТАЩЕР'; tagClass = 'bg-uc-red/20 text-uc-red font-bold'; }
      else if (a.calcRuin > 15) { tag = '⚠️ ОШИБАЛСЯ'; tagClass = 'bg-amber-500/20 text-amber-400'; }
      else { tag = '⚖️ СТАРАЛСЯ'; tagClass = 'bg-slate-800 text-slate-300'; }
    }

    const impactPercent = Math.max(10, Math.min(99, Math.round(50 + (a.calcImpact - 10) * 1.5)));

    const reasons = a.reasons || [
      {
        icon: a.kills >= 8 ? 'swords' : 'target',
        title: a.kills >= 8 ? `⚔️ ${a.kills} убийств в матче` : `🎯 KDA ${a.kills}/${a.deaths}/${a.assists}`,
        text: `Участие в убийствах команды: ${Math.round((((a.kills || 0) + (a.assists || 0)) / Math.max(1, allies.reduce((sum, p) => sum + (p.kills || 0), 0))) * 100)}%.`
      },
      {
        icon: (a.tower_damage || 0) >= 1500 ? 'building' : 'shield',
        title: `🏰 ${(a.tower_damage || 0).toLocaleString()} урона по вышкам`,
        text: `У команды всего ${allies.reduce((sum, p) => sum + (p.tower_damage || 0), 0).toLocaleString()} урона по строениям.`
      },
      {
        icon: 'coins',
        title: `💰 ${(a.net_worth || (a.gold_per_min * 20) || 0).toLocaleString()} золота (${a.gold_per_min || 0} GPM)`,
        text: `У союзников в среднем ${Math.round(allies.reduce((sum, p) => sum + (p.gold_per_min || 0), 0) / Math.max(1, allies.length))} GPM.`
      },
      {
        icon: a.deaths <= 4 ? 'shield-check' : 'skull',
        title: a.deaths <= 4 ? `🛡️ Всего ${a.deaths} смертей за игру` : `❌ ${a.deaths} смертей в матче`,
        text: `У команды всего ${allies.reduce((sum, p) => sum + (p.deaths || 0), 0)} смертей.`
      }
    ];

    return {
      role: rolePrefix,
      name: heroName,
      playerName: a.personaname || (isThisViewer ? currentPlayerName : 'Аноним'),
      heroId: a.hero_id,
      playerSlot: a.player_slot,
      kda: `${a.kills}/${a.deaths}/${a.assists}`,
      impact: a.impact || impactPercent,
      tag: a.tag || tag,
      tagClass: a.tagClass || tagClass,
      desc: a.desc || `${a.kills} фрагов, ${a.assists} ассистов, ${(a.tower_damage || 0).toLocaleString()} TD`,
      summary: a.summary || `KDA: <strong class="text-white">${a.kills}/${a.deaths}/${a.assists}</strong> • Золото: <strong>${(a.net_worth || 0).toLocaleString()}</strong> • Урон вышкам: <strong>${(a.tower_damage || 0).toLocaleString()}</strong>`,
      reasons: reasons
    };
  });

  let defaultCandidate = isWin ? topAllyMvp : topAllyRuiner;
  const defaultHeroName = getHeroName(defaultCandidate.hero_id);
  const defaultPlayerName = defaultCandidate.personaname || 'Аноним';

  const defaultCulprit = {
    isMvp: isWin,
    playerSlot: defaultCandidate.player_slot,
    headerTitle: isWin ? 'Главный спаситель и тащер матча (MVP)' : 'Главный виновник поражения (Анти-MVP матча)',
    badge: isWin ? '👑 ТОП-1 MVP МАТЧА' : '🛑 ГЛАВНЫЙ РУИНЕР МАТЧА',
    badgeClass: isWin ? 'bg-uc-red/20 text-uc-red border-uc-red/40' : 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    heroId: defaultCandidate.hero_id,
    name: `${defaultHeroName} (${defaultPlayerName})`,
    roleBadge: defaultCandidate.role || (isWin ? 'Топ-1 импакт команды' : 'Анти-MVP'),
    kda: `${defaultCandidate.kills} / ${defaultCandidate.deaths} / ${defaultCandidate.assists} (GPM: ${defaultCandidate.gold_per_min || 0})`,
    summary: defaultCandidate.summary || (isWin ? `Урон строениям: <strong class="text-emerald-400 font-bold">${(defaultCandidate.tower_damage || 0).toLocaleString()}</strong> • Золото: <strong class="text-uc-red font-bold">${(defaultCandidate.net_worth || 0).toLocaleString()}</strong>` : `Смертей: <strong class="text-rose-400 font-bold">${defaultCandidate.deaths}</strong> • Урон строениям: ${(defaultCandidate.tower_damage || 0).toLocaleString()}`),
    reasons: formattedTeammates.find(t => t.playerSlot === defaultCandidate.player_slot)?.reasons || []
  };

  const title = isWin
    ? (topAllyMvp.hero_id === viewer.hero_id
        ? `🏆 ПОБЕДА: ТВОЙ ${viewerHeroName.toUpperCase()} СТАЛ ТОП-1 MVP МАТЧА И РАЗНЕС ВРАГОВ!`
        : `🏆 ПОБЕДА ЗА ${durationStr}: ЛУЧШИЙ ИМПАКТ У ${getHeroName(topAllyMvp.hero_id).toUpperCase()}, ТВОЙ ГЕРОЙ — ${viewerHeroName.toUpperCase()}`)
    : (topAllyRuiner.hero_id === viewer.hero_id
        ? `💀 ПОРАЖЕНИЕ: ТВОЙ ${viewerHeroName.toUpperCase()} — ХУДШИЙ ПО ИМПАКТУ В КОМАНДЕ (${viewer.deaths} СМЕРТЕЙ)`
        : `💀 ПОРАЖЕНИЕ: САМЫЙ СЛАБЫЙ ИМПАКТ В КОМАНДЕ У ${getHeroName(topAllyRuiner.hero_id).toUpperCase()} (${topAllyRuiner.kills}/${topAllyRuiner.deaths}/${topAllyRuiner.assists})`);

  const desc = isWin
    ? `Победа ${isRadiant ? 'сил Света' : 'сил Тьмы'} за ${durationStr}. Топ-1 тащер матча — ${getHeroName(topAllyMvp.hero_id)} (${topAllyMvp.kills}/${topAllyMvp.deaths}, ${(topAllyMvp.tower_damage || 0).toLocaleString()} TD). Твой результат на ${viewerHeroName}: ${viewer.kills}/${viewer.deaths}/${viewer.assists} и ${viewer.gold_per_min || 0} GPM.`
    : `Поражение ${isRadiant ? 'сил Света' : 'сил Тьмы'} за ${durationStr}. Самый низкий импакт — ${getHeroName(topAllyRuiner.hero_id)} (${topAllyRuiner.deaths} смертей, ${(topAllyRuiner.tower_damage || 0).toLocaleString()} урона по вышкам). Твой результат на ${viewerHeroName}: ${viewer.kills}/${viewer.deaths}/${viewer.assists} и ${viewer.gold_per_min || 0} GPM.`;

  return {
    isWin,
    title,
    desc,
    positionNote: positions.exact ? '' : 'Позиции со знаком ≈ примерные: Valve и OpenDota не отдают их до разбора реплея. Сайт оценил их по золоту и роли героя. Для позиций по реплею нажми «Запросить разбор реплея» ниже.',
    culprit: defaultCulprit,
    teammates: formattedTeammates,
    enemyDanger: realMatch.enemyDanger || {
      name: `${getHeroName(topEnemyThreat.hero_id)} (${topEnemyThreat.kills}/${topEnemyThreat.deaths}/${topEnemyThreat.assists})`,
      heroId: topEnemyThreat.hero_id,
      desc: `Самый высокий импакт у врагов: ${topEnemyThreat.kills} фрагов, ${(topEnemyThreat.tower_damage || 0).toLocaleString()} урона по вышкам.`
    },
    enemyRuiner: realMatch.enemyRuiner || (topEnemyRuiner ? {
      name: `${getHeroName(topEnemyRuiner.hero_id)} (${topEnemyRuiner.kills}/${topEnemyRuiner.deaths}/${topEnemyRuiner.assists})`,
      heroId: topEnemyRuiner.hero_id,
      desc: `Самый низкий импакт у врагов: ${topEnemyRuiner.deaths} смертей.`
    } : null),
    moments: realMatch.moments || buildRealMoments(realMatch, durationStr, viewer)
  };
}

// Только события, которые есть в ответе API. Выдуманные тайминги здесь не нужны.
function buildRealMoments(match, durationStr, viewer) {
  const moments = [];
  if (match.first_blood_time != null) {
    moments.push({ time: formatMatchDuration(match.first_blood_time), phase: 'ПЕРВАЯ КРОВЬ', title: 'Первая кровь', desc: 'Первое убийство в матче.' });
  }
  const details = match.details;
  if (moments.length === 0 && details && details.firstBlood != null) {
    moments.push({ time: formatMatchDuration(details.firstBlood), phase: 'ПЕРВАЯ КРОВЬ', title: 'Первая кровь', desc: 'Первое убийство в матче.' });
  }
  if (details && viewer) {
    const lane = laneResult(match, viewer);
    if (lane && lane !== 'tie') {
      moments.push({ time: '10:00', phase: 'ЛИНИЯ', title: lane === 'win' ? 'Линия выиграна' : 'Линия проиграна', desc: 'Итог стадии линий по данным STRATZ.' });
    }
    const swing = worstSwing(details.leads, viewer.player_slot < 128);
    if (swing) {
      moments.push({ time: formatClock(Math.min(swing.minute * 60, match.duration || Infinity)), phase: 'ПЕРЕЛОМ', title: 'Резкая потеря золота', desc: `Команда потеряла ${Math.abs(swing.change).toLocaleString()} золота за 3 минуты.` });
    }
    const detail = playerDetail(match, viewer);
    if (detail && detail.deaths.length > 0) {
      const first = detail.deaths.reduce((a, b) => (a.time < b.time ? a : b));
      moments.push({ time: formatClock(first.time), phase: 'СМЕРТЬ', title: 'Твоя первая смерть', desc: deathReasons(first).join(', ') || 'Подробности смотри в разборе ошибок ниже.' });
    }
  }
  (match.objectives || [])
    .filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL')
    .forEach((o, i) => {
      moments.push({ time: formatMatchDuration(o.time), phase: 'РОШАН', title: `Рошан #${i + 1}`, desc: `Рошана убили ${o.team === 2 ? 'силы Света' : 'силы Тьмы'}.` });
    });
  moments.push({
    time: durationStr,
    phase: 'ФИНАЛ',
    title: match.radiant_win ? 'Победа сил Света' : 'Победа сил Тьмы',
    desc: match.radiant_score != null ? `Итоговый счёт: ${match.radiant_score} : ${match.dire_score}.` : 'Матч завершён.'
  });
  const seconds = clock => String(clock).split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
  return moments.sort((a, b) => seconds(a.time) - seconds(b.time));
}

const POSITION_NAMES = { 1: 'Лёгкая', 2: 'Центр', 3: 'Сложная', 4: 'Поддержка', 5: 'Полная поддержка' };

function heroFitsPosition(heroId, position) {
  const role = (HEROES_DB[heroId] && HEROES_DB[heroId].role) || '';
  return role.includes({ 1: 'Carry', 2: 'Mid', 3: 'Offlane' }[position]) ? 1 : 0;
}

// Настоящая линия есть только у разобранных матчей (lane_role). Без неё даём оценку и помечаем её знаком ≈.
function assignTeamPositions(team) {
  const labels = new Map();
  if (team.length !== 5) return { labels, exact: false };

  // Позиция от STRATZ: берём как есть, если она есть у всей команды и не повторяется
  const known = team.map(p => p.position);
  if (known.every(Boolean) && new Set(known).size === 5) {
    team.forEach(p => labels.set(p.player_slot, POSITION_NAMES[p.position]));
    return { labels, exact: true };
  }

  const byWorth = [...team].sort((a, b) => (b.net_worth || 0) - (a.net_worth || 0));

  if (team.every(p => p.lane_role != null)) {
    const placed = new Map();
    [1, 2, 3].forEach(lane => {
      const core = byWorth.find(p => p.lane_role === lane && !p.is_roaming && !placed.has(p.player_slot));
      if (core) placed.set(core.player_slot, lane);
    });
    const freePositions = [1, 2, 3, 4, 5].filter(n => ![...placed.values()].includes(n));
    byWorth
      .filter(p => !placed.has(p.player_slot))
      .sort((a, b) => Number(b.lane_role === 3 || !!b.is_roaming) - Number(a.lane_role === 3 || !!a.is_roaming))
      .forEach((p, i) => placed.set(p.player_slot, freePositions[i]));
    placed.forEach((position, slot) => labels.set(slot, POSITION_NAMES[position]));
    return { labels, exact: true };
  }

  // Чистые саппорты не должны попадать в коры только потому, что у них много золота
  const isPureSupport = p => (HEROES_DB[p.hero_id] && HEROES_DB[p.hero_id].role) === 'Support';
  const ordered = [...byWorth.filter(p => !isPureSupport(p)), ...byWorth.filter(isPureSupport)];
  const [a, b, c, support, hardSupport] = ordered;
  const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
  let best = orders[0];
  let bestScore = -1;
  orders.forEach(order => {
    const score = order.reduce((sum, p, i) => sum + heroFitsPosition(p.hero_id, i + 1), 0);
    if (score > bestScore) {
      best = order;
      bestScore = score;
    }
  });
  best.forEach((p, i) => labels.set(p.player_slot, `≈ ${POSITION_NAMES[i + 1]}`));
  labels.set(support.player_slot, `≈ ${POSITION_NAMES[4]}`);
  labels.set(hardSupport.player_slot, `≈ ${POSITION_NAMES[5]}`);
  return { labels, exact: false };
}

function buildPendingStory(m, isWin) {
  const heroName = getHeroName(m.hero_id);
  const failed = !!m.__fetchFailed;
  return {
    isWin,
    title: failed ? 'ДАННЫЕ ОСТАЛЬНЫХ ИГРОКОВ НЕДОСТУПНЫ' : 'ЗАГРУЖАЮ ДАННЫЕ ВСЕХ 10 ИГРОКОВ...',
    desc: failed
      ? 'OpenDota не вернул этот матч, поэтому ниже только твои показатели.'
      : 'Подгружаю матч с OpenDota.',
    culprit: {
      headerTitle: 'Твой результат в матче',
      badge: isWin ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ',
      badgeClass: isWin ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400',
      heroId: m.hero_id,
      name: `${heroName} (${currentPlayerName})`,
      roleBadge: 'Ты',
      kda: `${m.kills ?? 0} / ${m.deaths ?? 0} / ${m.assists ?? 0}`,
      summary: `GPM: <strong>${formatStat(m.gold_per_min)}</strong> • Урон вышкам: <strong>${formatStat(m.tower_damage)}</strong>`,
      reasons: []
    },
    teammates: [],
    enemyDanger: null,
    moments: []
  };
}

function getMatchStoryData(m, isWin) {
  const live = REAL_MATCH_CACHE[m.match_id];
  return live ? buildStoryFromRealMatch(live, m.hero_id, m.player_slot) : buildPendingStory(m, isWin);
}

function renderMatchStory(m, isWin) {
  const story = getMatchStoryData(m, isWin);
  currentReplayStoryData = story;
  selectedTeammateIndex = 0;

  // 1. Verdict Card
  const vCard = document.getElementById('rp-verdict-card');
  const vTag = document.getElementById('rp-verdict-tag');
  const vTitle = document.getElementById('rp-verdict-title');
  const vDesc = document.getElementById('rp-verdict-desc');
  const vDuration = document.getElementById('rp-match-duration');

  if (vCard) {
    vCard.className = `glass rounded-2xl p-6 border-l-4 ${isWin ? 'border-l-emerald-500' : 'border-l-uc-red'} space-y-3 relative overflow-hidden`;
    vTag.className = `px-3 py-1 rounded-full text-xs font-mono font-bold uppercase ${isWin ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'} flex items-center gap-1.5`;
    vTag.innerHTML = isWin ? '<i data-lucide="trophy" class="w-4 h-4"></i> ВЕРДИКТ: ПОЧЕМУ ЭТО ПОБЕДА' : '<i data-lucide="alert-octagon" class="w-4 h-4"></i> ВЕРДИКТ: ПОЧЕМУ ЭТО ПОРАЖЕНИЕ';
    vDuration.textContent = `Длительность: ${formatMatchDuration(m.duration)}`;
    vTitle.textContent = story.title;
    vDesc.textContent = story.desc;
  }

  // 2. Teammates Impact Grid (5 positions) with click to inspect!
  const tmGrid = document.getElementById('rp-teammates-grid');
  if (tmGrid && story.teammates) {
    tmGrid.innerHTML = story.teammates.map((t, idx) => {
      const icon = getHeroIcon(t.heroId || 1);
      const isSelected = (idx === selectedTeammateIndex);
      const borderClass = isSelected
        ? 'border-2 border-uc-red ring-2 ring-uc-red/30 bg-uc-red/10 shadow-md shadow-uc-red/10'
        : 'border border-slate-800 hover:border-slate-600 bg-slate-900/40';
      return `
        <div onclick="selectTeammateDossier(${idx})" class="teammate-card-item glass p-3 rounded-xl ${borderClass} space-y-2 cursor-pointer transition-colors ">
          <div class="flex items-center gap-2">
            <img loading="lazy" decoding="async" src="${icon}" alt="${t.name}" class="w-8 h-5 object-cover rounded border border-slate-700">
            <div class="overflow-hidden">
              <div class="text-xs font-mono font-bold text-slate-400 uppercase truncate">${t.role}</div>
              <div class="text-xs font-bold text-white truncate">${t.name} <span class="text-xs text-slate-400 font-normal">(${esc(t.playerName || 'Игрок')})</span></div>
            </div>
          </div>
          <div class="text-xs font-mono text-slate-400">KDA: <strong class="text-white">${t.kda}</strong></div>
          <div>
            <div class="flex justify-between text-xs font-mono mb-1">
              <span class="text-slate-400">ИМПАКТ</span>
              <span class="font-bold text-white">${t.impact}%</span>
            </div>
            <div class="w-full bg-black/60 rounded-full h-1.5 overflow-hidden">
              <div class="h-full rounded-full ${t.impact >= 75 ? 'bg-emerald-400' : t.impact >= 50 ? 'bg-amber-400' : 'bg-rose-500'}" style="width: ${t.impact}%"></div>
            </div>
          </div>
          <span class="inline-block px-1.5 py-0.5 rounded text-xs font-mono font-bold ${t.tagClass}">${t.tag}</span>
          <p class="text-xs text-slate-300 leading-tight font-sans pt-1 border-t border-slate-800/80">${t.desc}</p>
        </div>
      `;
    }).join('');
  }

  if (story.positionNote) showReplayNotice(story.positionNote);

  // 3. Culprit / MVP Dossier (Initial load or first teammate)
  const c = story.culprit;
  const cHeaderTitle = document.getElementById('rp-culprit-header-title');
  const cBadge = document.getElementById('rp-culprit-badge');
  const cImg = document.getElementById('rp-culprit-img');
  const cRoleBadge = document.getElementById('rp-culprit-role-badge');
  const cName = document.getElementById('rp-culprit-name');
  const cKda = document.getElementById('rp-culprit-kda');
  const cSummary = document.getElementById('rp-culprit-summary');
  const cReasons = document.getElementById('rp-culprit-reasons');

  if (cHeaderTitle) cHeaderTitle.textContent = c.headerTitle;
  if (cBadge) {
    cBadge.textContent = c.badge;
    cBadge.className = `px-2.5 py-1 rounded-lg text-xs font-mono font-bold ${c.badgeClass}`;
  }
  if (cImg) cImg.src = getHeroIcon(c.heroId);
  if (cRoleBadge) cRoleBadge.textContent = c.roleBadge;
  if (cName) cName.textContent = c.name;
  if (cKda) cKda.textContent = c.kda;
  if (cSummary) cSummary.innerHTML = c.summary;

  if (cReasons) {
    cReasons.innerHTML = c.reasons.map((r, i) => `
      <div class="p-3 rounded-xl bg-black/40 border border-slate-800/80 flex items-start gap-3">
        <span class="w-6 h-6 rounded-lg bg-uc-red/15 text-uc-red font-mono font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">
          0${i + 1}
        </span>
        <div class="space-y-0.5">
          <h6 class="font-outfit font-bold text-xs text-white">${r.title}</h6>
          <p class="text-[13px] text-slate-300 leading-relaxed font-sans">${r.text}</p>
        </div>
      </div>
    `).join('');
  }

  if (typeof renderPlayerCase === 'function' && c.playerSlot != null) renderPlayerCase(c.playerSlot);
  if (typeof renderEnemyChips === 'function') renderEnemyChips(m);

  // 4. Enemy Danger Card
  const enemyCard = document.getElementById('rp-enemy-mvp-card');
  if (enemyCard && !story.enemyDanger) enemyCard.innerHTML = '';
  if (enemyCard && story.enemyDanger) {
    const enemyIcon = getHeroIcon(story.enemyDanger.heroId || 28);
    enemyCard.innerHTML = `
      <div class="flex items-center gap-3">
        <img loading="lazy" decoding="async" src="${enemyIcon}" alt="${story.enemyDanger.name}" class="w-12 h-8 object-cover rounded-lg border border-amber-500/40">
        <div>
          <span class="text-xs uppercase font-mono font-bold text-amber-400">ГЛАВНАЯ УГРОЗА ВРАГА:</span>
          <h5 class="text-sm font-bold text-white">${story.enemyDanger.name}</h5>
          <p class="text-xs text-slate-300 leading-snug mt-0.5">${story.enemyDanger.desc}</p>
        </div>
      </div>
    `;
  }

  // 5. Fatal Moments Timeline
  const momentsGrid = document.getElementById('rp-fatal-moments-grid');
  if (momentsGrid && story.moments) {
    momentsGrid.innerHTML = story.moments.map(m => `
      <div class="p-3 rounded-xl bg-black/40 border border-slate-800/80 space-y-1.5">
        <div class="flex items-center justify-between text-xs font-mono">
          <span class="font-bold text-uc-red flex items-center gap-1">
            <i data-lucide="clock" class="w-3 h-3"></i> ${m.time}
          </span>
          <span class="px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 uppercase text-xs">${m.phase}</span>
        </div>
        <h6 class="text-xs font-bold text-white">${m.title}</h6>
        <p class="text-[13px] text-slate-300 leading-relaxed font-sans">${m.desc}</p>
      </div>
    `).join('');
  }
}

function selectTeammateDossier(idx) {
  if (!currentReplayStoryData || !currentReplayStoryData.teammates) return;
  selectedTeammateIndex = idx;
  const t = currentReplayStoryData.teammates[idx];
  if (!t) return;

  // Highlight selected card
  document.querySelectorAll('.teammate-card-item').forEach((el, i) => {
    if (i === idx) {
      el.className = 'teammate-card-item glass p-3 rounded-xl border-2 border-uc-red ring-2 ring-uc-red/30 bg-uc-red/10 space-y-2 cursor-pointer transition-colors shadow-md shadow-uc-red/10';
    } else {
      el.className = 'teammate-card-item glass p-3 rounded-xl border border-slate-800 hover:border-slate-600 bg-slate-900/40 space-y-2 cursor-pointer transition-colors ';
    }
  });

  const cHeaderTitle = document.getElementById('rp-culprit-header-title');
  const cBadge = document.getElementById('rp-culprit-badge');
  const cImg = document.getElementById('rp-culprit-img');
  const cRoleBadge = document.getElementById('rp-culprit-role-badge');
  const cName = document.getElementById('rp-culprit-name');
  const cKda = document.getElementById('rp-culprit-kda');
  const cSummary = document.getElementById('rp-culprit-summary');
  const cReasons = document.getElementById('rp-culprit-reasons');

  if (cHeaderTitle) cHeaderTitle.textContent = `Досье игрока: ${t.name} ${t.playerName ? '• ' + t.playerName : ''}`;
  if (cBadge) {
    cBadge.textContent = t.tag;
    cBadge.className = `px-2.5 py-1 rounded-lg text-xs font-mono font-bold ${t.tagClass || 'bg-uc-red/20 text-uc-red'}`;
  }
  if (cImg) cImg.src = getHeroIcon(t.heroId);
  if (cRoleBadge) cRoleBadge.textContent = t.role;
  if (cName) cName.textContent = `${t.name} (${t.playerName || 'Игрок'})`;
  if (cKda) cKda.textContent = `${t.kda} • Импакт: ${t.impact}%`;
  if (cSummary) cSummary.innerHTML = t.summary || `Участие в тимфайтах: <strong class="text-emerald-400 font-bold">${t.impact}%</strong>`;

  if (cReasons && t.reasons) {
    cReasons.innerHTML = t.reasons.map((r, i) => `
      <div class="p-3 rounded-xl bg-black/40 border border-slate-800/80 flex items-start gap-3">
        <span class="w-6 h-6 rounded-lg bg-uc-red/15 text-uc-red font-mono font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">
          0${i + 1}
        </span>
        <div class="space-y-0.5">
          <h6 class="font-outfit font-bold text-xs text-white">${r.title}</h6>
          <p class="text-[13px] text-slate-300 leading-relaxed font-sans">${r.text}</p>
        </div>
      </div>
    `).join('');
  }
  if (typeof renderPlayerCase === 'function') renderPlayerCase(t.playerSlot);
}

function setPhaseCard(id, badge, isGood, title, desc, tip) {
  const badgeEl = document.getElementById(`phase-${id}-badge`);
  badgeEl.textContent = badge;
  badgeEl.className = `px-2 py-0.5 rounded text-xs font-bold font-mono ${isGood ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`;
  document.getElementById(`phase-${id}-title`).textContent = title;
  document.getElementById(`phase-${id}-desc`).textContent = desc;
  document.getElementById(`phase-${id}-tip`).textContent = tip;
}

function benchmarkName(value, table, lowerIsBetter = false) {
  let reached = 'Ниже Рекрута';
  RANK_STEPS.forEach(step => {
    if (lowerIsBetter ? value <= table[step] : value >= table[step]) reached = RANK_STEP_NAMES[step];
  });
  return reached;
}

// Три карточки показывают фактические цифры матча. Что происходило по минутам, из этих данных не видно.
function renderPhases(m) {
  const bench = BENCHMARKS[isSupportGame(m) ? 'support' : 'core'];
  const gpm = m.gold_per_min ?? 0;
  const deaths = m.deaths ?? 0;
  const td = m.tower_damage ?? 0;
  const turbo = isTurbo(m);

  const gpmLevel = turbo ? 'Турбо' : benchmarkName(gpm, bench.gpm);
  setPhaseCard('laning', gpmLevel, !turbo && gpm >= bench.gpm.crusader, `${gpm.toLocaleString()} GPM`,
    turbo ? 'В Турбо золота намного больше, поэтому с рангами не сравниваем.' : `Ориентир для твоей роли: Рыцарь от ${bench.gpm.crusader}.`,
    'Смотри на добивания в первые 10 минут: от них зависит весь темп.');

  const deathLevel = turbo ? 'Турбо' : benchmarkName(deaths, bench.deaths, true);
  setPhaseCard('mid', deathLevel, deaths <= bench.deaths.crusader, `${deaths} смертей`,
    `Ориентир для твоей роли: Рыцарь до ${bench.deaths.crusader}.`,
    'Перед выходом на карту проверь, кого из врагов не видно.');

  const tdLevel = turbo ? 'Турбо' : benchmarkName(td, bench.towerDamage);
  setPhaseCard('late', tdLevel, td >= bench.towerDamage.crusader, `${td.toLocaleString()} урона по вышкам`,
    `Ориентир для твоей роли: Рыцарь от ${bench.towerDamage.crusader}.`,
    'После выигранной драки сразу иди на вышку или Рошана.');
}

function buildMatchMistakes(match, viewer) {
  const isRadiant = viewer.player_slot < 128;
  const team = match.players.filter(p => (p.player_slot < 128) === isRadiant);
  const enemies = match.players.filter(p => (p.player_slot < 128) !== isRadiant);
  const mistakes = [];
  const good = [];

  const teamKills = team.reduce((sum, p) => sum + (p.kills || 0), 0);
  const teamDeaths = team.reduce((sum, p) => sum + (p.deaths || 0), 0);
  const allyDeaths = average(team.filter(p => p !== viewer).map(p => p.deaths || 0));
  const deaths = viewer.deaths || 0;

  if (deaths >= 6 && deaths >= allyDeaths * 1.3) {
    mistakes.push(`${deaths} смертей: у союзников в среднем ${allyDeaths.toFixed(1)}. Это ${Math.round((deaths / Math.max(1, teamDeaths)) * 100)}% всех смертей команды.`);
  } else if (deaths <= allyDeaths * 0.6) {
    good.push(`${deaths} смертей: у союзников в среднем ${allyDeaths.toFixed(1)}.`);
  }

  if (teamKills > 0) {
    const share = Math.round((((viewer.kills || 0) + (viewer.assists || 0)) / teamKills) * 100);
    if (share < 45) mistakes.push(`Участие в убийствах команды только ${share}%: тебя часто не было в драках.`);
    else if (share >= 65) good.push(`Участие в убийствах команды ${share}%.`);
  }

  const teamPositions = assignTeamPositions(team);
  const enemyPositions = assignTeamPositions(enemies).labels;
  const positionsExact = teamPositions.exact;
  const myPosition = (teamPositions.labels.get(viewer.player_slot) || '').replace('≈ ', '');
  const rivalLabel = positionsExact ? 'соперника на твоей позиции' : 'вероятного соперника на твоей позиции';
  const rival = enemies.find(p => (enemyPositions.get(p.player_slot) || '').replace('≈ ', '') === myPosition);
  if (rival && rival.gold_per_min > 0 && viewer.gold_per_min > 0) {
    const name = getHeroName(rival.hero_id);
    if (viewer.gold_per_min < rival.gold_per_min * 0.85) {
      mistakes.push(`${viewer.gold_per_min} GPM против ${rival.gold_per_min} у ${name}, ${rivalLabel}.`);
    } else if (viewer.gold_per_min > rival.gold_per_min * 1.15) {
      good.push(`${viewer.gold_per_min} GPM против ${rival.gold_per_min} у ${name}, ${rivalLabel}.`);
    }
  }

  // Вывод про вышки делаем только при известной позиции или явно коровом герое
  const core = positionsExact
    ? !/поддержка/i.test(myPosition)
    : !isHeroSupport(viewer.hero_id, viewer.gold_per_min || 0, viewer.assists || 0, viewer.kills || 0);
  if (core && match.duration >= 1500 && (viewer.tower_damage || 0) < 500) {
    mistakes.push(`Только ${(viewer.tower_damage || 0).toLocaleString()} урона по вышкам за ${formatMatchDuration(match.duration)} на кор-позиции.`);
  }

  const detail = playerDetail(match, viewer);
  if (detail) {
    const lane = laneResult(match, viewer);
    const where = LANE_NAMES[detail.lane] || 'линии';
    if (lane === 'loss') mistakes.unshift(`Проиграна стадия линий на ${where}.`);
    if (lane === 'win') good.push(`Выиграна стадия линий на ${where}.`);

    const early = detail.deaths.filter(d => d.time < 600).length;
    if (early >= 2) mistakes.push(`${early} смерти в первые 10 минут: враг рано получил золото и темп.`);

    const fast = detail.deaths.filter(d => d.isBurst).length;
    if (fast >= 3) mistakes.push(`${fast} раз убили за секунды: нужен предмет на выживание или позиция дальше от врага.`);

    const unused = detail.deaths.filter(d => d.hasHealAvailable).length;
    if (unused >= 2) mistakes.push(`${unused} раза умер с доступным лечением: нажимай его раньше.`);

    const lost = detail.deaths.reduce((sum, d) => sum + (d.goldLost || 0), 0);
    if (lost >= 1500) mistakes.push(`Потеряно ${lost.toLocaleString()} золота на смертях.`);

    const kicks = detail.kills.filter(k => k.isSolo).length;
    if (kicks >= 3) good.push(`${kicks} соло-убийств.`);
    if (detail.award && AWARD_NAMES[detail.award]) good.unshift(`Награда матча: ${AWARD_NAMES[detail.award]}.`);
  }

  return { mistakes, good };
}

function renderMatchMistakes(m) {
  const box = document.getElementById('match-mistakes');
  if (!box) return;

  const live = getLiveMatchData(m);
  if (!live) {
    box.innerHTML = liveNotice(m.__fetchFailed ? 'Данные матча недоступны, поэтому сравнить с другими игроками нельзя.' : 'Загружаю данные матча...');
    return;
  }

  const { mistakes, good } = buildMatchMistakes(live.match, live.player);
  const row = (text, bad) => `<div class="p-3 rounded-xl bg-black/40 border ${bad ? 'border-rose-500/30 text-rose-200' : 'border-emerald-500/30 text-emerald-200'} text-xs">${bad ? '❌' : '✅'} ${esc(text)}</div>`;
  box.innerHTML = mistakes.length + good.length > 0
    ? mistakes.map(t => row(t, true)).join('') + good.map(t => row(t, false)).join('')
    : liveNotice('В цифрах этого матча явных ошибок нет: показатели близки к команде и сопернику.');
}

function renderHeroSpecificTips(heroId) {
  const container = document.getElementById('hero-tips-content');
  if (!container) return;

  const heroName = getHeroName(heroId);

  const tipsMap = {
    113: { // Arc Warden
      build: 'Hand of Midas ➔ Boots of Travel ➔ Maelstrom / Gleipnir ➔ BKB / Manta ➔ Daedalus / Bloodthorn',
      spikes: '1-й пик силы — Hand of Midas (на 9-11 мин). 2-й пик — Gleipnir (на 20-22 мин).',
      rules: [
        'Всегда жми Midas сначала с оригинала, затем СРАЗУ с копии — это даёт двойное золото каждые 90 секунд!',
        'Во время драк ставь Magnetic Field так, чтобы край купола накрывал тебя, давая 100% уклонение от дальних атак.',
        'Отправляй копию под Travel Boots на пустую линию сносить крипов каждые 40 секунд, пока сам стоишь в безопасности.'
      ]
    },
    74: { // Invoker
      build: 'Urn / Spirit Vessel ➔ Witch Blade ➔ BKB ➔ Aghanim Scepter ➔ Refresher Orb',
      spikes: '1-й пик — 7 уровень (Cold Snap + Forge Spirit + Urn). 2-й пик — BKB + Meteor + Deafening Blast.',
      rules: [
        'На Рекрутах не пытайся нажимать 10 заклинаний. Доведи до идеала комбо из 3 кнопок: Tornado ➔ Chaos Meteor ➔ Deafening Blast.',
        'Держи 3 сферы Exort при фарме крипов для максимального урона тычки, и переключайся на 3 Quas для регенерации.',
        'Всегда вешай Alacrity на своего катапультного крипа при осаде вышки — башня падает за 10 секунд!'
      ]
    },
    90: { // KotL
      build: 'Tranquil Boots ➔ Glimmer Cape ➔ Force Staff ➔ Aghanim Scepter',
      spikes: 'Пик силы — получение 6 уровня (Solar Bind + Spirit Form) и покупка Glimmer Cape.',
      rules: [
        'Не воруй фарм у керри своей волной Illuminate! Заряжай её из кустов в героев врага, а не в крипов.',
        'Используй Chakra Magic на союзного мидера по кулдауну, чтобы он постоянно спамил скиллами.',
        'На низком рейтинге KotL сильно зависит от союзников: играй ближе к тому, кто реализует твою ману и контроль.'
      ]
    }
  };

  const current = tipsMap[heroId] || {
    build: 'Power Treads / Phase ➔ Основной артефакт ➔ BKB ➔ Предмет на урон / контроль',
    spikes: 'Тайминги зависят от раннего крипстата и отсутствия ранних смертей.',
    rules: [
      `На герое ${heroName} всегда фокусируйся на добивании крипов в первые 10 минут.`,
      'Покупай Black King Bar сразу после первого крупного боевого предмета.',
      'После каждого удачного убийства ломай ближайшую вышку!'
    ]
  };

  container.innerHTML = `
    <div class="space-y-3 text-xs font-mono">
      <div class="p-3 rounded-xl bg-black/40 border border-slate-800 space-y-1">
        <div class="text-[13px] text-uc-red font-bold uppercase">Оптимальная сборка на победу:</div>
        <div class="text-white">${current.build}</div>
      </div>

      <div class="p-3 rounded-xl bg-black/40 border border-slate-800 space-y-1">
        <div class="text-[13px] text-amber-300 font-bold uppercase">Тайминги и сила:</div>
        <div class="text-slate-300">${current.spikes}</div>
      </div>

      <div class="p-3 rounded-xl bg-black/40 border border-slate-800 space-y-1.5">
        <div class="text-[13px] text-emerald-400 font-bold uppercase">3 золотых правила игры на ${heroName}:</div>
        <ul class="space-y-1 text-slate-300 list-disc list-inside">
          ${current.rules.map(r => `<li>${r}</li>`).join('')}
        </ul>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════
// 7 PRO ANALYSIS MODULES (29 to 35) ENGINE
// ═══════════════════════════════════════════════════════════════════════

let currentActiveProModule = 29;
let currentActiveReplayMatch = null;

function switchProModule(num) {
  currentActiveProModule = num;
  for (let i = 29; i <= 35; i++) {
    const btn = document.getElementById(`btn-pm-${i}`);
    if (btn) {
      if (i === num) {
        btn.className = 'tab-active px-3 py-2 rounded-xl border flex items-center gap-1.5 whitespace-nowrap shadow-md';
      } else {
        btn.className = 'tab-inactive px-3 py-2 rounded-xl border flex items-center gap-1.5 whitespace-nowrap';
      }
    }
  }

  const m = currentActiveReplayMatch || currentMatches[0];
  if (!m) return;
  renderActiveProModule(num, m);
  refreshIcons();
}

function renderActiveProModule(num, m) {
  const container = document.getElementById('pro-module-content');
  if (!container || !m) return;
  container.innerHTML = renderProModuleLive(num, m);
}

const LANE_NAMES = { SAFE_LANE: 'лёгкой линии', MID_LANE: 'центре', OFF_LANE: 'сложной линии' };
const AWARD_NAMES = { MVP: 'MVP матча', TOP_CORE: 'лучший кор', TOP_SUPPORT: 'лучший саппорт' };
let itemNames = null;

function playerDetail(match, player) {
  return match.details && match.details.players ? match.details.players[player.hero_id] || null : null;
}

async function loadItemNames() {
  if (itemNames || !SERVER_MODE) return;
  try {
    const res = await fetch('/api/items');
    itemNames = res.ok ? await res.json() : null;
  } catch (e) {
    itemNames = null;
  }
}

function laneResult(match, player) {
  const detail = playerDetail(match, player);
  if (!detail || !detail.lane) return null;
  const isRadiant = player.player_slot < 128;
  const mapLane = detail.lane === 'MID_LANE' ? 'mid'
    : (detail.lane === 'SAFE_LANE') === isRadiant ? 'bottom' : 'top';
  const outcome = match.details.lanes[mapLane];
  if (!outcome || outcome === 'TIE') return outcome === 'TIE' ? 'tie' : null;
  return (outcome === 'RADIANT_VICTORY' || outcome === 'RADIANT_STOMP') === isRadiant ? 'win' : 'loss';
}

function deathReasons(death) {
  const reasons = [];
  if (death.isBurst) reasons.push('убили за секунды, не успел среагировать');
  if (death.hasHealAvailable) reasons.push('лечение было доступно, но не использовано');
  if (death.isAttemptTpOut) reasons.push('пытался уйти телепортом');
  if (death.isDieBack) reasons.push('умер сразу после возвращения');
  if (death.isEngagedOnDeath === false) reasons.push('поймали вне драки');
  return reasons;
}

function worstSwing(leads, isRadiant) {
  let best = null;
  for (let minute = 3; minute < leads.length; minute++) {
    const change = (leads[minute] - leads[minute - 3]) * (isRadiant ? 1 : -1);
    if (!best || change < best.change) best = { minute, change };
  }
  return best && best.change <= -2000 ? best : null;
}

function getLiveMatchData(m) {
  const match = REAL_MATCH_CACHE[m.match_id];
  if (!match) return null;
  const player = match.players.find(p => p.player_slot === m.player_slot);
  return player ? { match, player } : null;
}

function isMatchParsed(player, match) {
  const detail = match ? playerDetail(match, player) : null;
  return (detail && detail.deaths.length + detail.items.length > 0) || Array.isArray(player.purchase_log) || Array.isArray(player.obs_log) || Array.isArray(player.kills_log);
}

function formatClock(sec) {
  const abs = Math.abs(sec);
  return `${sec < 0 ? '-' : ''}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

function formatItemName(key) {
  return String(key).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function liveNotice(text, button = '') {
  return `<div class="glass p-5 rounded-2xl space-y-3 text-sm text-slate-300"><p>${esc(text)}</p>${button}</div>`;
}

function parseRequestBlock(m) {
  return liveNotice(
    'OpenDota ещё не разобрал реплей этого матча, поэтому покупок, вардов и таймингов смертей пока нет. Выдумывать их сайт не будет.',
    `<button onclick="requestMatchParse('${esc(m.match_id)}')" class="px-3 py-2 rounded-lg text-xs font-bold bg-uc-red hover:bg-uc-redHover text-white">Запросить разбор реплея</button>
     <p id="parse-status" class="text-xs text-slate-400"></p>`
  );
}

async function requestMatchParse(matchId) {
  const status = document.getElementById('parse-status');
  if (status) status.textContent = 'Отправляю запрос...';
  try {
    const res = await odFetch(`/request/${matchId}`, { method: 'POST' });
    if (status) {
      status.textContent = res.ok
        ? 'Запрос принят. Обычно разбор занимает несколько минут, потом открой матч заново.'
        : `OpenDota отклонил запрос (код ${res.status}). Реплей мог уже удалиться.`;
    }
  } catch (e) {
    if (status) status.textContent = e.message;
  }
}

function statCard(label, value, hint = '') {
  return `
    <div class="p-3 rounded-xl bg-black/40 border border-slate-800 space-y-1 font-mono text-xs">
      <span class="text-slate-400 text-xs uppercase">${esc(label)}</span>
      <div class="text-white font-bold text-lg">${esc(value ?? '—')}</div>
      ${hint ? `<p class="text-xs text-slate-400 font-sans">${esc(hint)}</p>` : ''}
    </div>`;
}

function statGrid(title, cards) {
  return `
    <div class="glass p-5 rounded-2xl space-y-3">
      <h5 class="text-xs font-mono font-bold text-slate-300 uppercase">${esc(title)}</h5>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">${cards.join('')}</div>
    </div>`;
}

function timelineList(title, rows) {
  return `
    <div class="glass p-5 rounded-2xl space-y-3">
      <h5 class="text-xs font-mono font-bold text-slate-300 uppercase">${esc(title)}</h5>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 font-mono text-xs">
        ${rows.map(r => `
          <div class="p-2.5 rounded-lg bg-black/40 border border-slate-800 flex justify-between gap-2">
            <span class="text-white">${esc(r.label)}</span>
            <span class="text-slate-400">${esc(r.time)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

const RUNE_NAMES = { 0: 'двойной урон', 1: 'ускорение', 2: 'иллюзии', 3: 'невидимость', 4: 'регенерация', 5: 'богатство', 6: 'чародейство', 7: 'вода', 8: 'мудрость', 9: 'щит' };

const CONSUMABLE_ITEMS = new Set(['tango', 'tango_single', 'flask', 'clarity', 'enchanted_mango', 'faerie_fire', 'ward_observer', 'ward_sentry', 'ward_dispenser', 'tpscroll', 'dust', 'smoke_of_deceit', 'branches', 'blood_grenade']);

function extractDeaths(match, player) {
  const detail = playerDetail(match, player);
  if (detail && detail.deaths.length > 0) {
    return detail.deaths
      .map(d => ({ ...d, killer: d.attacker }))
      .sort((a, b) => a.time - b.time);
  }
  const hero = HEROES_DB[player.hero_id];
  if (!hero) return [];
  const heroKey = `npc_dota_hero_${hero.slug}`;
  const isRadiant = player.player_slot < 128;
  const deaths = [];
  match.players
    .filter(p => (p.player_slot < 128) !== isRadiant)
    .forEach(enemy => {
      (enemy.kills_log || []).forEach(k => {
        if (k.key === heroKey) deaths.push({ time: k.time, killer: enemy.hero_id });
      });
    });
  return deaths.sort((a, b) => a.time - b.time);
}

function renderProModuleLive(num, m) {
  const live = getLiveMatchData(m);
  if (!live) {
    return liveNotice(m.__fetchFailed ? 'OpenDota не вернул этот матч, поэтому модуль недоступен.' : 'Загружаю данные матча...');
  }

  const { match, player } = live;
  const parsed = isMatchParsed(player, match);
  const detail = playerDetail(match, player);
  const isRadiant = player.player_slot < 128;
  const teamKills = match.players
    .filter(p => (p.player_slot < 128) === isRadiant)
    .reduce((sum, p) => sum + (p.kills || 0), 0);

  switch (num) {
    case 29: {
      if (!parsed) return parseRequestBlock(m);
      const purchases = detail && detail.items.length > 0
        ? detail.items.map(i => ({ time: i.time, key: (itemNames && itemNames[i.itemId]) || `item_${i.itemId}` }))
        : player.purchase_log || [];
      const items = purchases.filter(i => !CONSUMABLE_ITEMS.has(i.key) && !String(i.key).startsWith('recipe'));
      return timelineList('Покупки предметов в этом матче', items.map(i => ({ label: formatItemName(i.key), time: formatClock(i.time) })));
    }
    case 30: {
      if (!parsed) return parseRequestBlock(m);
      if (detail && player.obs_placed == null) {
        return statGrid('Варды в этом матче', [statCard('Поставлено вардов', detail.wards.length)]);
      }
      return statGrid('Варды в этом матче', [
        statCard('Observer поставлено', player.obs_placed ?? (player.obs_log || []).length),
        statCard('Sentry поставлено', player.sen_placed ?? (player.sen_log || []).length),
        statCard('Сбито Observer врага', player.observer_kills),
        statCard('Сбито Sentry врага', player.sentry_kills)
      ]);
    }
    case 31:
      return liveNotice('OpenDota не отдаёт положение героев во время драк, поэтому позиционирование посчитать нельзя.');
    case 32: {
      if (!parsed) return parseRequestBlock(m);
      const rows = [];
      if (match.first_blood_time != null) rows.push({ label: 'Первая кровь', time: formatClock(match.first_blood_time) });
      (match.objectives || [])
        .filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL')
        .forEach(o => rows.push({ label: `Рошан (${o.team === 2 ? 'Свет' : 'Тьма'})`, time: formatClock(o.time) }));
      if (detail) {
        const lane = laneResult(match, player);
        if (lane) rows.push({ label: `Линия: ${lane === 'win' ? 'выиграна' : lane === 'loss' ? 'проиграна' : 'вничью'}`, time: '10:00' });
        const swing = worstSwing(match.details.leads, isRadiant);
        if (swing) rows.push({ label: `Потеряно ${Math.abs(swing.change).toLocaleString()} золота за 3 минуты`, time: `${swing.minute}:00` });
      }
      (player.runes_log || []).forEach(r => rows.push({ label: `Руна: ${RUNE_NAMES[r.key] || r.key}`, time: formatClock(r.time) }));
      return timelineList('Ключевые события матча', rows);
    }
    case 33: {
      const share = teamKills > 0 ? Math.round((((player.kills || 0) + (player.assists || 0)) / teamKills) * 100) : 0;
      const fights = Array.isArray(match.teamfights) ? match.teamfights : null;
      const slotIndex = match.players.indexOf(player);
      const joined = fights
        ? fights.filter(f => {
            const stats = f.players && f.players[slotIndex];
            return stats && (stats.damage > 0 || stats.deaths > 0 || stats.healing > 0);
          }).length
        : null;
      return statGrid('Участие в драках', [
        statCard('Участие в убийствах', `${share}%`, `${(player.kills || 0) + (player.assists || 0)} из ${teamKills} убийств команды`),
        statCard('Тимфайтов с участием', fights ? `${joined} из ${fights.length}` : null, fights ? '' : 'Нужен разбор реплея')
      ]);
    }
    case 34: {
      const hits = detail ? detail.lastHits.slice(0, 10) : [];
      const lane = player.lh_t && player.lh_t[10] != null
        ? player.lh_t[10]
        : hits.length === 10 ? hits.reduce((a, b) => a + b, 0) : null;
      return statGrid('Экономика матча', [
        statCard('Всего заработано', player.gold_per_min != null ? `${Math.round(player.gold_per_min * match.duration / 60).toLocaleString()}G` : null),
        statCard('Итоговая ценность', player.net_worth != null ? `${player.net_worth.toLocaleString()}G` : null),
        statCard('Добивания / денаи', `${player.last_hits ?? '—'} / ${player.denies ?? '—'}`),
        statCard('Добиваний к 10 мин', lane, lane === null ? 'Нужен разбор реплея' : '')
      ]);
    }
    case 35: {
      if (!parsed) return parseRequestBlock(m);
      return timelineList(`Смерти в матче (${player.deaths ?? 0})`, extractDeaths(match, player).map(d => ({ label: `Убил ${getHeroName(d.killer)}`, time: formatClock(d.time) })));
    }
    default:
      return '';
  }
}

function renderLiveDeaths(m) {
  const container = document.getElementById('death-timeline');
  if (!container) return;

  const live = getLiveMatchData(m);
  if (!live) {
    container.innerHTML = liveNotice(m.__fetchFailed ? 'Данные матча недоступны.' : 'Загружаю данные матча...');
    return;
  }
  if ((live.player.deaths ?? 0) === 0) {
    container.innerHTML = liveNotice('В этом матче ты ни разу не умер.');
    return;
  }
  if (!isMatchParsed(live.player, live.match)) {
    container.innerHTML = liveNotice(`Смертей в матче: ${live.player.deaths}. Время и убийц видно только после разбора реплея: нажми «Запросить разбор реплея» в блоке ниже.`);
    return;
  }

  container.innerHTML = extractDeaths(live.match, live.player).map((d, i) => {
    const reasons = deathReasons(d);
    const cost = [];
    if (d.goldLost) cost.push(`потеряно ${d.goldLost.toLocaleString()} золота`);
    if (d.goldFed) cost.push(`враг получил ${d.goldFed.toLocaleString()}`);
    if (d.timeDead) cost.push(`мёртв ${d.timeDead} сек.`);
    return `
      <div class="glass p-4 rounded-xl space-y-1">
        <div class="flex items-center justify-between gap-2 text-sm">
          <span class="font-bold text-white">${formatClock(d.time)} • Смерть #${i + 1}</span>
          <span class="text-slate-400">${HEROES_DB[d.killer] ? `убил ${esc(getHeroName(d.killer))}` : ''}</span>
        </div>
        ${reasons.length > 0 ? `<p class="text-sm text-amber-300">${esc(reasons.join(', '))}</p>` : ''}
        ${cost.length > 0 ? `<p class="text-[13px] text-slate-400">${esc(cost.join(', '))}</p>` : ''}
      </div>`;
  }).join('');
}
