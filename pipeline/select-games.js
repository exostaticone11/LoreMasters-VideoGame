// Fetches and ranks games from Steam + SteamSpy APIs.
// Combines multiple sources to find popular recent games with trailers.

const STEAM_API_BASE = 'https://store.steampowered.com/api';
const STEAMSPY_API = 'https://steamspy.com/api.php';
const ADULT_TAGS = ['Nudity', 'Sexual Content', 'Adult Only', 'NSFW', 'Hentai'];
const MIN_REVIEWS = 500;

// Source 1: Steam featured categories (new releases, top sellers, coming soon)
async function fetchFeaturedGames() {
  const res = await fetch(`${STEAM_API_BASE}/featuredcategories?cc=us&l=en`);
  const data = await res.json();
  const appIds = new Set();
  for (const category of ['top_sellers', 'new_releases', 'coming_soon']) {
    const items = data[category]?.items || [];
    for (const item of items) {
      if (item.id) appIds.add(String(item.id));
    }
  }
  console.log(`[select] Steam featured: ${appIds.size} app IDs`);
  return [...appIds];
}

// Source 2: SteamSpy top 100 games by player count in last 2 weeks
async function fetchSteamSpyTop() {
  const res = await fetch(`${STEAMSPY_API}?request=top100in2weeks`);
  const data = await res.json();
  const games = Object.entries(data).map(([id, g]) => ({
    appId: id,
    name: g.name,
    positive: g.positive || 0,
  }));
  console.log(`[select] SteamSpy top100: ${games.length} games`);
  return games;
}

// Source 3: SteamSpy top 100 games in the last 2 weeks by current players
async function fetchSteamSpyTrending() {
  const res = await fetch(`${STEAMSPY_API}?request=top100owned`);
  const data = await res.json();
  const games = Object.entries(data).map(([id, g]) => ({
    appId: id,
    name: g.name,
    positive: g.positive || 0,
  }));
  console.log(`[select] SteamSpy top owned: ${games.length} games`);
  return games;
}

// Merge all sources into unique app IDs
async function fetchAllSources() {
  const [featured, spyTop, spyTrending] = await Promise.all([
    fetchFeaturedGames(),
    fetchSteamSpyTop(),
    fetchSteamSpyTrending(),
  ]);

  const allIds = new Set([
    ...featured,
    ...spyTop.map(g => g.appId),
    ...spyTrending.map(g => g.appId),
  ]);

  console.log(`[select] Total unique app IDs across all sources: ${allIds.size}`);
  return [...allIds];
}

// Get detailed info for a single app
async function fetchAppDetails(appId) {
  try {
    const res = await fetch(`${STEAM_API_BASE}/appdetails?appids=${appId}&cc=us&l=en`);
    const data = await res.json();

    if (!data[appId]?.success) return null;

    const info = data[appId].data;

    if (info.type !== 'game') return null;
    if (!info.movies?.length) return null;

    const genres = (info.genres || []).map(g => g.description);
    if (genres.some(g => ADULT_TAGS.includes(g))) return null;

    const categories = (info.categories || []).map(c => c.description);
    const releaseDate = info.release_date?.date ? new Date(info.release_date.date) : null;
    const isComingSoon = info.release_date?.coming_soon || false;

    const trailer = info.movies[0];
    const hlsUrl = trailer.hls_h264 || trailer.dash_h264;
    if (!hlsUrl) return null;

    return {
      appId,
      name: info.name,
      headerImage: info.header_image,
      releaseDate,
      isComingSoon,
      genres,
      tags: [...genres, ...categories],
      trailerUrl: hlsUrl,
      trailerName: trailer.name,
      reviewCount: info.recommendations?.total || 0,
      shortDescription: info.short_description,
    };
  } catch (err) {
    console.warn(`[select] Failed to fetch details for ${appId}: ${err.message}`);
    return null;
  }
}

// Rate-limited batch fetch
async function fetchAllDetails(appIds, delayMs = 250) {
  const results = [];
  for (let i = 0; i < appIds.length; i++) {
    const app = await fetchAppDetails(appIds[i]);
    if (app) results.push(app);

    if ((i + 1) % 20 === 0) {
      console.log(`[select] Fetched ${i + 1}/${appIds.length} (${results.length} valid)`);
    }

    if (i < appIds.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// Filter and rank games
function rankGames(games, maxAgeDays = 30) {
  const now = new Date();
  const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const cutoff60 = new Date(now - 60 * 24 * 60 * 60 * 1000);

  // Heavy hitter filter: must have MIN_REVIEWS or be coming soon
  let filtered = games.filter(g => {
    if (g.isComingSoon) return true;
    return g.reviewCount >= MIN_REVIEWS;
  });

  console.log(`[select] ${filtered.length} games with ${MIN_REVIEWS}+ reviews (or coming soon)`);

  // Score each game: recency is king, popularity is tiebreaker
  const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000);
  const cutoff180 = new Date(now - 180 * 24 * 60 * 60 * 1000);

  filtered = filtered.map(g => {
    let recencyBonus = 0;
    if (g.isComingSoon) recencyBonus = 4;
    else if (g.releaseDate && g.releaseDate >= cutoff30) recencyBonus = 5;  // Last 30 days = top priority
    else if (g.releaseDate && g.releaseDate >= cutoff60) recencyBonus = 3;
    else if (g.releaseDate && g.releaseDate >= cutoff90) recencyBonus = 2;
    else if (g.releaseDate && g.releaseDate >= cutoff180) recencyBonus = 1;
    // Older than 6 months = 0 (still in pool but lowest priority)
    return { ...g, recencyBonus };
  });

  // Sort: recency first, then review count
  filtered.sort((a, b) => {
    if (a.recencyBonus !== b.recencyBonus) return b.recencyBonus - a.recencyBonus;
    return b.reviewCount - a.reviewCount;
  });

  console.log(`[select] Top 15 candidates:`);
  filtered.slice(0, 15).forEach(g =>
    console.log(`  ${g.name} - ${g.reviewCount} reviews [recency: ${g.recencyBonus}] ${g.isComingSoon ? '(coming soon)' : ''}`)
  );

  return filtered;
}

// Pick games for a specific difficulty tier
function pickGamesForDay(rankedPool, dayOfWeek, count = 10, usedAppIds = new Set()) {
  const available = rankedPool.filter(g => !usedAppIds.has(g.appId));

  if (available.length < count) {
    console.warn(`[select] Only ${available.length} available games, need ${count}`);
  }

  // Split into 5 tiers based on position in ranked list
  const tierSize = Math.ceil(available.length / 5);
  const tierStart = dayOfWeek * tierSize;
  const tierEnd = Math.min(tierStart + tierSize * 2, available.length);

  let tierGames = available.slice(tierStart, tierEnd);
  if (tierGames.length < count) tierGames = available;

  const shuffled = tierGames.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export { fetchAllSources, fetchAllDetails, rankGames, pickGamesForDay };
