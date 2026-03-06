// Downloads a Steam trailer, extracts frames, OCR scans for game title,
// finds a safe 10s window, and trims the clip.

import { execSync } from 'child_process';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import Tesseract from 'tesseract.js';

const CLIP_DURATION = 10;

// Each parallel job gets its own temp dir to avoid collisions
function makeTempDir(jobId) {
  const dir = join(process.cwd(), `.tmp_${jobId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// Download full trailer from Steam HLS URL
function downloadTrailer(hlsUrl, outputPath) {
  console.log(`[trailer] Downloading trailer...`);
  execSync(
    `ffmpeg -i "${hlsUrl}" -c copy -y "${outputPath}"`,
    { stdio: 'pipe', timeout: 120000 }
  );
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
  execSync(
    `ffmpeg -i "${videoPath}" -vf fps=1 -q:v 2 "${join(outputDir, 'frame_%04d.png')}" -y`,
    { stdio: 'pipe', timeout: 120000 }
  );
  return readdirSync(outputDir)
    .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
    .sort();
}

// OCR a single frame, return detected text
async function ocrFrame(framePath, worker) {
  const { data: { text } } = await worker.recognize(framePath);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

// Check if game name appears in OCR text
function nameMatchesOcr(gameName, ocrText) {
  const normalized = gameName.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = normalized.split(/\s+/).filter(w => w.length >= 3);

  if (words.length <= 2) {
    return ocrText.includes(normalized);
  }

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
  if (curLen > bestLen) {
    bestStart = curStart;
    bestLen = curLen;
  }

  if (bestLen < minDuration) return null;

  const margin = Math.floor((bestLen - minDuration) / 2);
  return { startSec: bestStart + margin, duration: minDuration, windowSize: bestLen };
}

// Trim + encode to final format (720p 30fps CRF 28)
function trimAndEncode(inputPath, outputPath, startSec, duration) {
  console.log(`[trailer] Trimming clip: ${startSec}s for ${duration}s`);
  execSync(
    `ffmpeg -ss ${startSec} -i "${inputPath}" -t ${duration} ` +
    `-vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" ` +
    `-r 30 -c:v libx264 -profile:v high -crf 28 -preset medium -maxrate 2M -bufsize 4M ` +
    `-c:a aac -b:a 96k -movflags +faststart -y "${outputPath}"`,
    { stdio: 'pipe', timeout: 120000 }
  );
}

// Full pipeline for one game — isolated temp dir per job
async function processTrailer(game, outputClipPath, jobId = 0) {
  const tempDir = makeTempDir(jobId);
  const trailerPath = join(tempDir, 'trailer.mp4');
  const framesDir = join(tempDir, 'frames');

  try {
    // 1. Download
    downloadTrailer(game.trailerUrl, trailerPath);

    // 2. Get duration
    const duration = getVideoDuration(trailerPath);
    console.log(`[trailer:${jobId}] ${game.name} — ${duration.toFixed(1)}s, trailer: "${game.trailerName}"`);

    if (duration < CLIP_DURATION + 5) {
      console.warn(`[trailer:${jobId}] Too short (${duration}s), skipping OCR, using start=5`);
      trimAndEncode(trailerPath, outputClipPath, 5, CLIP_DURATION);
      return { success: true, startSec: 5, skippedOcr: true };
    }

    // 3. Extract frames
    mkdirSync(framesDir, { recursive: true });
    const frameFiles = extractFrames(trailerPath, framesDir);
    console.log(`[trailer:${jobId}] ${frameFiles.length} frames extracted`);

    // 4. OCR scan
    const worker = await Tesseract.createWorker('eng');
    const frameResults = [];

    for (let i = 0; i < frameFiles.length; i++) {
      const ocrText = await ocrFrame(join(framesDir, frameFiles[i]), worker);
      const hasTitle = nameMatchesOcr(game.name, ocrText);
      frameResults.push({ second: i, hasTitle });
      if (hasTitle) {
        console.log(`[trailer:${jobId}]   Frame ${i}s: TITLE DETECTED`);
      }
    }

    await worker.terminate();

    const titleFrames = frameResults.filter(f => f.hasTitle).length;
    console.log(`[trailer:${jobId}] OCR: ${titleFrames}/${frameResults.length} frames have title`);

    // 5. Find safe window
    const safeWindow = findSafeWindow(frameResults);

    if (!safeWindow) {
      console.warn(`[trailer:${jobId}] No safe ${CLIP_DURATION}s window!`);
      const fallbackStart = Math.min(20, Math.floor(duration / 3));
      trimAndEncode(trailerPath, outputClipPath, fallbackStart, CLIP_DURATION);
      return { success: true, startSec: fallbackStart, safeWindow: false };
    }

    console.log(`[trailer:${jobId}] Safe window: ${safeWindow.startSec}s (${safeWindow.windowSize}s clean)`);

    // 6. Trim + encode
    trimAndEncode(trailerPath, outputClipPath, safeWindow.startSec, CLIP_DURATION);

    return { success: true, startSec: safeWindow.startSec, safeWindow: true };

  } catch (err) {
    console.error(`[trailer:${jobId}] Error: ${game.name} — ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    cleanDir(tempDir);
  }
}

export { processTrailer };
