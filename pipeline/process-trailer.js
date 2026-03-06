// Downloads a Steam trailer, extracts frames, OCR scans for game title,
// finds a safe 10s window, and trims the clip.

import { execSync } from 'child_process';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import Tesseract from 'tesseract.js';

const TEMP_DIR = join(process.cwd(), '.tmp');
const CLIP_DURATION = 10;

function ensureTempDir() {
  mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanTempDir() {
  if (!existsSync(TEMP_DIR)) return;
  rmSync(TEMP_DIR, { recursive: true, force: true });
  mkdirSync(TEMP_DIR, { recursive: true });
}

// Download full trailer from Steam HLS URL
function downloadTrailer(hlsUrl, outputPath) {
  console.log(`[trailer] Downloading trailer...`);
  execSync(
    `ffmpeg -i "${hlsUrl}" -c copy -y "${outputPath}"`,
    { stdio: 'pipe', timeout: 120000 }
  );
  console.log(`[trailer] Downloaded to ${outputPath}`);
}

// Get video duration in seconds
function getVideoDuration(videoPath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
    { encoding: 'utf-8', timeout: 10000 }
  );
  return parseFloat(result.trim());
}

// Extract 1 frame per second as PNGs
function extractFrames(videoPath, outputDir) {
  console.log(`[trailer] Extracting frames...`);
  execSync(
    `ffmpeg -i "${videoPath}" -vf fps=1 -q:v 2 "${join(outputDir, 'frame_%04d.png')}" -y`,
    { stdio: 'pipe', timeout: 120000 }
  );
  const frames = readdirSync(outputDir)
    .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
    .sort();
  console.log(`[trailer] Extracted ${frames.length} frames`);
  return frames;
}

// OCR a single frame, return detected text
async function ocrFrame(framePath, worker) {
  const { data: { text } } = await worker.recognize(framePath);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

// Check if game name appears in OCR text
function nameMatchesOcr(gameName, ocrText) {
  // Normalize the game name for fuzzy matching
  const normalized = gameName.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = normalized.split(/\s+/).filter(w => w.length >= 3);

  // If 2+ significant words from the title appear in sequence, it's a match
  if (words.length <= 2) {
    // Short titles: require exact substring
    return ocrText.includes(normalized);
  }

  // Longer titles: check if majority of significant words appear
  const matchCount = words.filter(w => ocrText.includes(w)).length;
  return matchCount >= Math.ceil(words.length * 0.6);
}

// Find the longest consecutive run of "safe" frames (no game title detected)
function findSafeWindow(frameResults, minDuration = CLIP_DURATION) {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < frameResults.length; i++) {
    if (!frameResults[i].hasTitle) {
      if (curStart === -1) curStart = i;
      curLen++;
    } else {
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  // Check final run
  if (curLen > bestLen) {
    bestStart = curStart;
    bestLen = curLen;
  }

  if (bestLen < minDuration) {
    return null; // No safe window long enough
  }

  // Pick a start point that's centered in the safe window with some margin
  const margin = Math.floor((bestLen - minDuration) / 2);
  const startSec = bestStart + margin;

  return { startSec, duration: minDuration, windowSize: bestLen };
}

// Trim the video to a specific window
function trimClip(inputPath, outputPath, startSec, duration) {
  console.log(`[trailer] Trimming clip: ${startSec}s for ${duration}s`);
  execSync(
    `ffmpeg -ss ${startSec} -i "${inputPath}" -t ${duration} -c:v libx264 -c:a aac -movflags +faststart -y "${outputPath}"`,
    { stdio: 'pipe', timeout: 60000 }
  );
  console.log(`[trailer] Clip saved to ${outputPath}`);
}

// Full pipeline for one game
async function processTrailer(game, outputClipPath) {
  ensureTempDir();
  cleanTempDir();

  const trailerPath = join(TEMP_DIR, 'trailer.mp4');

  try {
    // 1. Download
    downloadTrailer(game.trailerUrl, trailerPath);

    // 2. Get duration
    const duration = getVideoDuration(trailerPath);
    console.log(`[trailer] Duration: ${duration.toFixed(1)}s`);

    if (duration < CLIP_DURATION + 5) {
      console.warn(`[trailer] Video too short (${duration}s), skipping OCR, using start=5`);
      trimClip(trailerPath, outputClipPath, 5, CLIP_DURATION);
      return { success: true, startSec: 5, skippedOcr: true };
    }

    // 3. Extract frames
    const framesDir = join(TEMP_DIR, 'frames');
    mkdirSync(framesDir, { recursive: true });
    const frameFiles = extractFrames(trailerPath, framesDir);

    // 4. OCR scan each frame
    console.log(`[trailer] Running OCR on ${frameFiles.length} frames for "${game.name}"...`);
    const worker = await Tesseract.createWorker('eng');

    const frameResults = [];
    for (let i = 0; i < frameFiles.length; i++) {
      const framePath = join(framesDir, frameFiles[i]);
      const ocrText = await ocrFrame(framePath, worker);
      const hasTitle = nameMatchesOcr(game.name, ocrText);

      frameResults.push({
        second: i,
        hasTitle,
        ocrSnippet: ocrText.slice(0, 80),
      });

      if (hasTitle) {
        console.log(`[trailer]   Frame ${i}s: TITLE DETECTED - "${ocrText.slice(0, 60)}"`);
      }
    }

    await worker.terminate();

    const titleFrames = frameResults.filter(f => f.hasTitle).length;
    console.log(`[trailer] OCR complete: ${titleFrames}/${frameResults.length} frames contain title`);

    // 5. Find safe window
    const safeWindow = findSafeWindow(frameResults);

    if (!safeWindow) {
      console.warn(`[trailer] No safe ${CLIP_DURATION}s window found!`);
      // Fallback: skip first 20s and last 10s, hope for the best
      const fallbackStart = Math.min(20, Math.floor(duration / 3));
      trimClip(trailerPath, outputClipPath, fallbackStart, CLIP_DURATION);
      return { success: true, startSec: fallbackStart, safeWindow: false };
    }

    console.log(`[trailer] Safe window: starts at ${safeWindow.startSec}s (${safeWindow.windowSize}s clean)`);

    // 6. Trim clip
    trimClip(trailerPath, outputClipPath, safeWindow.startSec, CLIP_DURATION);

    return { success: true, startSec: safeWindow.startSec, safeWindow: true };

  } catch (err) {
    console.error(`[trailer] Error processing ${game.name}: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    cleanTempDir();
  }
}

export { processTrailer };
