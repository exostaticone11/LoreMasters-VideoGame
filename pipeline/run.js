#!/usr/bin/env node

// Daily game selection pipeline.
// Fetches games from Steam, processes trailers (download + OCR + trim),
// generates wrong answers, and outputs the quiz data.
//
// Usage: node run.js [dayOfWeek]
//   dayOfWeek: 0=Monday (easiest) ... 4=Friday (hardest). Default: auto-detect.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fetchAllSources, fetchAllDetails, rankGames, pickGamesForDay } from './select-games.js';
import { processTrailer } from './process-trailer.js';
import { generateWrongAnswers, buildAnswers } from './generate-answers.js';

const OUTPUT_DIR = join(process.cwd(), 'output');
const CLIPS_DIR = join(OUTPUT_DIR, 'clips');
const GAMES_PER_DAY = 10;

// Determine day of week (0=Mon, 4=Fri)
function getDayOfWeek() {
  const arg = process.argv[2];
  if (arg !== undefined) return parseInt(arg, 10);
  const jsDay = new Date().getDay(); // 0=Sun, 1=Mon...
  // Map: Mon=0, Tue=1, Wed=2, Thu=3, Fri=4
  if (jsDay === 0 || jsDay === 6) return 0; // Weekend defaults to Monday
  return jsDay - 1;
}

async function main() {
  const dayOfWeek = getDayOfWeek();
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  console.log(`\n=== LoreMasters Pipeline - ${dayNames[dayOfWeek]} (difficulty ${dayOfWeek}/4) ===\n`);

  mkdirSync(CLIPS_DIR, { recursive: true });

  // Load previously used games (if tracking file exists)
  const usedFile = join(OUTPUT_DIR, 'used_games.json');
  let usedAppIds = new Set();
  if (existsSync(usedFile)) {
    const used = JSON.parse(readFileSync(usedFile, 'utf-8'));
    usedAppIds = new Set(used.map(String));
    console.log(`[pipeline] ${usedAppIds.size} games already used this week`);
  }

  // Step 1: Fetch game pool from Steam
  console.log('\n--- Step 1: Fetching games from Steam ---');
  const appIds = await fetchAllSources();

  // Step 2: Get details for all games
  console.log('\n--- Step 2: Fetching app details ---');
  const allGames = await fetchAllDetails(appIds);
  console.log(`[pipeline] ${allGames.length} valid games with trailers`);

  if (allGames.length < GAMES_PER_DAY) {
    console.error(`[pipeline] Not enough games! Found ${allGames.length}, need ${GAMES_PER_DAY}`);
    process.exit(1);
  }

  // Step 3: Rank by difficulty
  console.log('\n--- Step 3: Ranking games ---');
  const ranked = rankGames(allGames);
  console.log(`[pipeline] ${ranked.length} games after filtering`);
  console.log('[pipeline] Top 5 (easiest):');
  ranked.slice(0, 5).forEach(g => console.log(`  ${g.name} (${g.reviewCount} reviews)`));
  console.log('[pipeline] Bottom 5 (hardest):');
  ranked.slice(-5).forEach(g => console.log(`  ${g.name} (${g.reviewCount} reviews)`));

  // Step 4: Pick games for today
  console.log('\n--- Step 4: Picking games for today ---');
  const todaysGames = pickGamesForDay(ranked, dayOfWeek, GAMES_PER_DAY, usedAppIds);
  console.log(`[pipeline] Selected ${todaysGames.length} games:`);
  todaysGames.forEach(g => console.log(`  - ${g.name}`));

  // Step 5: Process trailers (download, OCR, trim)
  console.log('\n--- Step 5: Processing trailers ---');
  const quizQuestions = [];
  const failedGames = [];

  for (let i = 0; i < todaysGames.length; i++) {
    const game = todaysGames[i];
    console.log(`\n[${i + 1}/${todaysGames.length}] Processing: ${game.name}`);

    const clipFilename = `${game.appId}.mp4`;
    const clipPath = join(CLIPS_DIR, clipFilename);

    const result = await processTrailer(game, clipPath);

    if (!result.success) {
      console.warn(`[pipeline] FAILED: ${game.name} - ${result.error}`);
      failedGames.push(game.name);
      continue;
    }

    // Step 6: Generate wrong answers
    const wrongAnswers = generateWrongAnswers(game, allGames);
    const answers = buildAnswers(game.name, wrongAnswers);

    quizQuestions.push({
      id: quizQuestions.length + 1,
      name: game.name,
      clip: `/clips/${clipFilename}`,
      steamAppId: parseInt(game.appId),
      answers,
      startSec: result.startSec,
      safeWindow: result.safeWindow ?? false,
      genres: game.genres,
    });
  }

  // Step 7: Output results
  console.log('\n--- Step 7: Writing output ---');

  if (quizQuestions.length === 0) {
    console.error('[pipeline] No questions generated! Pipeline failed.');
    process.exit(1);
  }

  // Write quiz data
  const quizFile = join(OUTPUT_DIR, 'quiz.json');
  writeFileSync(quizFile, JSON.stringify(quizQuestions, null, 2));
  console.log(`[pipeline] Quiz data written to ${quizFile} (${quizQuestions.length} questions)`);

  // Update used games list
  const allUsed = [...usedAppIds, ...quizQuestions.map(q => String(q.steamAppId))];
  writeFileSync(usedFile, JSON.stringify(allUsed));
  console.log(`[pipeline] Used games updated (${allUsed.length} total)`);

  // Summary
  console.log('\n=== PIPELINE COMPLETE ===');
  console.log(`Questions generated: ${quizQuestions.length}/${GAMES_PER_DAY}`);
  if (failedGames.length > 0) {
    console.log(`Failed games: ${failedGames.join(', ')}`);
  }
  console.log(`Output: ${OUTPUT_DIR}`);

  // Print quiz for quick review
  console.log('\n--- Quiz Preview ---');
  quizQuestions.forEach(q => {
    const correctIdx = q.answers.indexOf(q.name);
    console.log(`  Q${q.id}: ${q.name} [answer position: ${correctIdx}] [start: ${q.startSec}s] [safe: ${q.safeWindow}]`);
    console.log(`       ${q.answers.join(' | ')}`);
  });
}

main().catch(err => {
  console.error('[pipeline] Fatal error:', err);
  process.exit(1);
});
