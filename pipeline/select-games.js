// Fetches and ranks games from Steam APIs only (no SteamSpy dependency).
// Sources: Featured categories, Most Played, Search API.

const STEAM_API_BASE = 'https://store.steampowered.com/api';
const STEAM_CHARTS_API = 'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/';
const ADULT_TAGS = ['Nudity', 'Sexual Content', 'Adult Only', 'NSFW', 'Hentai'];
const MIN_REVIEWS = 500;

// Source 1: Steam featured categories (new releases, top sellers, coming soon)
async function fetchFeaturedGames() {
  const res = await fetch(`${STEAM_API_BASE}/featuredcategories?cc=us&l=en`);
  const data = await res.json();
  const appIds = new Set();
  for (const category of ['top_sellers', 'new_releases', 'coming_soon', 'specials']) {
    const items = data[category]?.items || [];
    for (const item of items) {
      if (item.id) appIds.add(String(item.id));
    }
  }
  console.log(`[select] Steam featured: ${appIds.size} app IDs`);
  return [...appIds];
}

// Source 2: Steam Charts — most played games right now
async function fetchMostPlayed() {
  try {
    const res = await fetch(STEAM_CHARTS_API);
    const data = await res.json();
    const ranks = data?.response?.ranks || [];
    const appIds = ranks.map(r => String(r.appid));
    console.log(`[select] Steam Charts most played: ${appIds.length} games`);
    return appIds;
  } catch (err) {
    console.warn(`[select] Steam Charts failed: ${err.message}`);
    return [];
  }
}

// Source 3: Steam search — recently released popular games
async function fetchRecentPopular() {
  try {
    // Search for recently released games sorted by reviews
    const res = await fetch(
      'https://store.steampowered.com/search/results/?sort_by=Reviews_DESC&category1=998&os=win&ignore_preferences=1&ndl=1&count=100&force_infinite=1&json=1'
    );
    const data = await res.json();
    const items = data?.items || [];
    const appIds = items.map(i => String(i.id || i.appid)).filter(Boolean);
    console.log(`[select] Steam search recent popular: ${appIds.length} games`);
    return appIds;
  } catch (err) {
    console.warn(`[select] Steam search failed: ${err.message}`);
    return [];
  }
}

// Merge all sources into unique app IDs
async function fetchAllSources() {
  const [featured, mostPlayed, recentPopular] = await Promise.all([
    fetchFeaturedGames(),
    fetchMostPlayed(),
    fetchRecentPopular(),
  ]);

  const allIds = new Set([...featured, ...mostPlayed, ...recentPopular]);
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

    // Smart trailer selection: prefer gameplay, skip accolades/DLC/update
    const trailer = pickBestTrailer(info.movies);
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
      trailerIndex: info.movies.indexOf(trailer),
      reviewCount: info.recommendations?.total || 0,
      shortDescription: info.short_description,
    };
  } catch (err) {
    console.warn(`[select] Failed to fetch details for ${appId}: ${err.message}`);
    return null;
  }
}

// Pick the best trailer — prefer gameplay, skip accolades/DLC/update
function pickBestTrailer(movies) {
  const PREFER = ['gameplay', 'launch', 'official trailer', 'announcement', 'reveal'];
  const AVOID = ['accolades', 'review', 'update', 'dlc', 'expansion', 'season', 'patch', 'colosseum', 'event', 'crossover'];

  // Score each trailer
  const scored = movies.map((m, i) => {
    const name = (m.name || '').toLowerCase();
    let score = 0;

    // Boost preferred keywords
    for (const kw of PREFER) {
      if (name.includes(kw)) score += 10;
    }

    // Penalize avoided keywords
    for (const kw of AVOID) {
      if (name.includes(kw)) score -= 20;
    }

    // Slight preference for earlier trailers (main ones tend to be listed first among good ones)
    score -= i * 0.5;

    return { movie: m, score, index: i };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].movie;
}

// Rate-limited batch fetch with concurrency control
async function fetchAllDetails(appIds, concurrency = 5) {
  const results = [];
  let completed = 0;

  // Process in batches for controlled concurrency
  for (let i = 0; i < appIds.length; i += concurrency) {
    const batch = appIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(id => fetchAppDetails(id)));

    for (const app of batchResults) {
      if (app) results.push(app);
    }

    completed += batch.length;
    if (completed % 20 === 0 || completed === appIds.length) {
      console.log(`[select] Fetched ${completed}/${appIds.length} (${results.length} valid)`);
    }

    // Small delay between batches to respect rate limits
    if (i + concurrency < appIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return results;
}

// Filter and rank games
function rankGames(games) {
  const now = new Date();
  const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const cutoff60 = new Date(now - 60 * 24 * 60 * 60 * 1000);
  const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000);
  const cutoff180 = new Date(now - 180 * 24 * 60 * 60 * 1000);

  // Heavy hitter filter: must have MIN_REVIEWS or be coming soon
  let filtered = games.filter(g => {
    if (g.isComingSoon) return true;
    return g.reviewCount >= MIN_REVIEWS;
  });

  console.log(`[select] ${filtered.length} games with ${MIN_REVIEWS}+ reviews (or coming soon)`);

  // Score each game: recency is king, popularity is tiebreaker
  filtered = filtered.map(g => {
    let recencyBonus = 0;
    if (g.isComingSoon) recencyBonus = 4;
    else if (g.releaseDate && g.releaseDate >= cutoff30) recencyBonus = 5;
    else if (g.releaseDate && g.releaseDate >= cutoff60) recencyBonus = 3;
    else if (g.releaseDate && g.releaseDate >= cutoff90) recencyBonus = 2;
    else if (g.releaseDate && g.releaseDate >= cutoff180) recencyBonus = 1;
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

export { fetchAllSources, fetchAllDetails, rankGames, pickGamesForDay, pickBestTrailer };
