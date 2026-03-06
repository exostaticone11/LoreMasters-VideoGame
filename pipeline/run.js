#!/usr/bin/env node

// Weekly batch pipeline — runs Sunday 2am, processes all 50 games for Mon-Fri.
// Parallelizes trailer download + OCR across multiple workers.
//
// Usage:
//   node run.js              — full weekly batch (50 games, 5 days)
//   node run.js --day 0      — single day (0=Mon, 4=Fri)
//   node run.js --parallel 4 — set max parallel trailer jobs (default: 4)

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fetchAllSources, fetchAllDetails, rankGames, pickGamesForDay } from './select-games.js';
import { processTrailer } from './process-trailer.js';
import { generateWrongAnswers, buildAnswers } from './generate-answers.js';

const OUTPUT_DIR = join(process.cwd(), 'output');
const CLIPS_DIR = join(OUTPUT_DIR, 'clips');
const GAMES_PER_DAY = 10;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  let day = null;
  let parallel = 4;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--day' && args[i + 1]) day = parseInt(args[i + 1], 10);
    if (args[i] === '--parallel' && args[i + 1]) parallel = parseInt(args[i + 1], 10);
  }

  return { day, parallel };
}

// Process a batch of games in parallel with concurrency limit
async function processTrailersBatch(games, allGames, clipDir, maxParallel) {
  const results = [];
  let jobId = 0;

  // Process in chunks of maxParallel
  for (let i = 0; i < games.length; i += maxParallel) {
    const chunk = games.slice(i, i + maxParallel);
    const chunkPromises = chunk.map((game, idx) => {
      const id = jobId++;
      const clipPath = join(clipDir, `${game.appId}.mp4`);
      console.log(`[batch] Starting job ${id}: ${game.name} (trailer: "${game.trailerName}")`);

      return processTrailer(game, clipPath, id).then(result => {
        if (!result.success) {
          console.warn(`[batch] FAILED: ${game.name} — ${result.error}`);
          return null;
        }

        const wrongAnswers = generateWrongAnswers(game, allGames);
        const answers = buildAnswers(game.name, wrongAnswers);

        return {
          name: game.name,
          clip: `/clips/${game.appId}.mp4`,
          steamAppId: parseInt(game.appId),
          answers,
          startSec: result.startSec,
          safeWindow: result.safeWindow ?? false,
          genres: game.genres,
        };
      });
    });

    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults.filter(Boolean));
    console.log(`[batch] Progress: ${results.length} clips done, ${games.length - i - chunk.length} remaining`);
  }

  return results;
}

async function main() {
  const { day: singleDay, parallel } = parseArgs();
  const isWeekly = singleDay === null;

  console.log(`\n=== LoreMasters Pipeline ===`);
  console.log(`Mode: ${isWeekly ? 'WEEKLY BATCH (Mon-Fri)' : `SINGLE DAY (${DAYS[singleDay]})`}`);
  console.log(`Parallel jobs: ${parallel}\n`);

  mkdirSync(CLIPS_DIR, { recursive: true });

  // Load previously used games
  const usedFile = join(OUTPUT_DIR, 'used_games.json');
  let usedAppIds = new Set();
  if (isWeekly) {
    // Fresh week — reset used list
    usedAppIds = new Set();
    console.log(`[pipeline] Weekly batch: starting fresh`);
  } else if (existsSync(usedFile)) {
    const used = JSON.parse(readFileSync(usedFile, 'utf-8'));
    usedAppIds = new Set(used.map(String));
    console.log(`[pipeline] ${usedAppIds.size} games already used`);
  }

  // Step 1: Fetch game pool from Steam
  console.log('\n--- Step 1: Fetching games from Steam ---');
  const t0 = performance.now();
  const appIds = await fetchAllSources();
  console.log(`[pipeline] Sources fetched in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  // Step 2: Get details (parallel batches of 5)
  console.log('\n--- Step 2: Fetching app details ---');
  const t1 = performance.now();
  const allGames = await fetchAllDetails(appIds);
  console.log(`[pipeline] ${allGames.length} valid games with trailers in ${((performance.now() - t1) / 1000).toFixed(1)}s`);

  // Step 3: Rank
  console.log('\n--- Step 3: Ranking games ---');
  const ranked = rankGames(allGames);

  // Step 4: Pick games for each day
  const daysToProcess = isWeekly ? [0, 1, 2, 3, 4] : [singleDay];
  const weeklyData = {};
  const allSelectedGames = [];

  for (const dow of daysToProcess) {
    const todaysGames = pickGamesForDay(ranked, dow, GAMES_PER_DAY, usedAppIds);
    weeklyData[dow] = todaysGames;
    allSelectedGames.push(...todaysGames);

    // Mark as used so next day doesn't repeat
    todaysGames.forEach(g => usedAppIds.add(g.appId));

    console.log(`\n[pipeline] ${DAYS[dow]} (difficulty ${dow}/4): ${todaysGames.length} games`);
    todaysGames.forEach(g => console.log(`  - ${g.name} [trailer: "${g.trailerName}"]`));
  }

  // Step 5: Process ALL trailers in parallel
  console.log(`\n--- Step 5: Processing ${allSelectedGames.length} trailers (${parallel} parallel) ---`);
  const t2 = performance.now();
  const allQuestions = await processTrailersBatch(allSelectedGames, allGames, CLIPS_DIR, parallel);
  console.log(`[pipeline] All trailers processed in ${((performance.now() - t2) / 1000).toFixed(1)}s`);

  // Step 6: Split results back into daily quiz files
  console.log('\n--- Step 6: Writing output ---');

  // Build lookup from appId to question
  const questionMap = new Map();
  allQuestions.forEach(q => questionMap.set(q.steamAppId, q));

  for (const dow of daysToProcess) {
    const dayGames = weeklyData[dow];
    const dayQuestions = dayGames
      .map((g, i) => {
        const q = questionMap.get(parseInt(g.appId));
        if (!q) return null;
        return { id: i + 1, ...q };
      })
      .filter(Boolean);

    const filename = isWeekly ? `quiz_${DAYS[dow].toLowerCase()}.json` : 'quiz.json';
    const filepath = join(OUTPUT_DIR, filename);
    writeFileSync(filepath, JSON.stringify(dayQuestions, null, 2));
    console.log(`[pipeline] ${DAYS[dow]}: ${dayQuestions.length} questions -> ${filename}`);
  }

  // Also write a combined weekly file
  if (isWeekly) {
    const weekly = {};
    for (const dow of daysToProcess) {
      const dayGames = weeklyData[dow];
      weekly[DAYS[dow].toLowerCase()] = dayGames
        .map((g, i) => {
          const q = questionMap.get(parseInt(g.appId));
          if (!q) return null;
          return { id: i + 1, ...q };
        })
        .filter(Boolean);
    }
    writeFileSync(join(OUTPUT_DIR, 'quiz_weekly.json'), JSON.stringify(weekly, null, 2));
    console.log(`[pipeline] Weekly combined file written`);
  }

  // Update used games list
  writeFileSync(usedFile, JSON.stringify([...usedAppIds]));

  // Summary
  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);
  const failed = allSelectedGames.length - allQuestions.length;

  console.log('\n=== PIPELINE COMPLETE ===');
  console.log(`Total time: ${totalTime}s`);
  console.log(`Games processed: ${allQuestions.length}/${allSelectedGames.length}`);
  if (failed > 0) console.log(`Failed: ${failed}`);
  console.log(`Output: ${OUTPUT_DIR}`);

  // Quick preview
  console.log('\n--- Preview ---');
  for (const dow of daysToProcess) {
    console.log(`\n${DAYS[dow]}:`);
    const dayGames = weeklyData[dow];
    dayGames.forEach(g => {
      const q = questionMap.get(parseInt(g.appId));
      const status = q ? `start:${q.startSec}s safe:${q.safeWindow}` : 'FAILED';
      console.log(`  ${g.name} [${status}]`);
    });
  }
}

main().catch(err => {
  console.error('[pipeline] Fatal error:', err);
  process.exit(1);
});
