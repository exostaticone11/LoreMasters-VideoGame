# LoreMasters VideoGame

## Project Structure
- `prototype/` — Vite + vanilla JS frontend (quiz game)
- `pipeline/` — Node scripts for Steam trailer processing (ffmpeg + Tesseract OCR)
- `quiz_games.json` — Raw game data from pipeline

## Deployed
- Cloudflare Pages: https://loremasters.pages.dev
- GitHub: https://github.com/exostaticone11/LoreMasters-VideoGame

## Git
- Local branch: `master`, remote: `main`
- Push: `git push origin master:main`

## Video Clips
- Located in `prototype/public/clips/`
- 720p 30fps, H.264 High, CRF 28, faststart, AAC 96k
- ~1-2.5MB each (10s clips), ~15MB total for 10 clips
- Re-encode command: `ffmpeg -y -i input.mp4 -vf "scale=1280:720" -r 30 -c:v libx264 -profile:v high -crf 28 -preset medium -maxrate 2M -bufsize 4M -c:a aac -b:a 96k -movflags +faststart output.mp4`

## Video Loading Strategy
- ALL clips preloaded as blobs on page load (~15MB total, parallel fetch)
- Clip 0 fetched first (priority) — unlocks START button
- Remaining clips fetched in parallel with "X / 9 clips ready" progress
- Blob URLs used for instant playback from memory
- Timer only starts after `canplay` event — no buffering time counted against player
- 15s canplay timeout safety net to prevent infinite hang
- Telemetry logging in console (`[LM Xms]` prefix) for diagnosing playback issues

## Last Push
- `c3759f3` — Preload all clips on page load with progress indicator
- `c84a526` — Add video telemetry logging
- `e428da7` — Initial commit: prototype with video preloading and optimized clips
