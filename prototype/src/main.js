import { GAMES } from './games.js';
import './style.css';

// -- State --
let currentQuestion = 0;
let score = 0;
let streak = 0;
let bestStreak = 0;
let results = [];
let timerInterval = null;
let timeLeft = 10;
let answered = false;

const $ = (s) => document.querySelector(s);
const screens = {
  intro: $('#screen-intro'),
  game: $('#screen-game'),
  results: $('#screen-results'),
};

// -- Preloading --
const preloadedBlobs = new Map();
const preloadPromises = new Map();

function preloadClip(index) {
  if (index >= GAMES.length || preloadPromises.has(index)) return;
  const promise = fetch(GAMES[index].clip)
    .then(res => res.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      preloadedBlobs.set(index, url);
      return url;
    })
    .catch(() => GAMES[index].clip); // fallback to direct URL
  preloadPromises.set(index, promise);
  return promise;
}

function preloadUpcoming() {
  preloadClip(currentQuestion + 1);
  preloadClip(currentQuestion + 2);
}

// -- Screen management --
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// -- Timer --
function startTimer() {
  timeLeft = 10;
  const timerBar = $('#timer-bar');
  timerBar.style.transition = 'none';
  timerBar.style.width = '100%';
  timerBar.classList.remove('warning', 'danger');
  timerBar.offsetHeight;
  timerBar.style.transition = 'width 1s linear';

  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timeLeft--;
    timerBar.style.width = (timeLeft / 10) * 100 + '%';

    if (timeLeft <= 3) timerBar.classList.add('danger');
    else if (timeLeft <= 5) timerBar.classList.add('warning');

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      handleTimeout();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// -- Game flow --
async function startGame() {
  currentQuestion = 0;
  score = 0;
  streak = 0;
  bestStreak = 0;
  results = [];
  preloadedBlobs.forEach(url => URL.revokeObjectURL(url));
  preloadedBlobs.clear();
  preloadPromises.clear();
  updateScore();
  updateStreak();
  showScreen('game');

  // Wait for first clip to be ready before starting
  await preloadClip(0);
  loadQuestion();
}

async function loadQuestion() {
  answered = false;
  const game = GAMES[currentQuestion];

  $('#question-counter').textContent = `${currentQuestion + 1} / ${GAMES.length}`;
  $('#video-overlay').classList.add('hidden');

  // Use preloaded blob URL if available, otherwise fall back to direct URL
  const clipUrl = preloadedBlobs.get(currentQuestion) || game.clip;

  // Set up video — start muted to guarantee autoplay, then unmute
  const video = $('#game-video');
  video.muted = true;
  video.src = clipUrl;
  video.currentTime = 0;
  video.loop = true;

  // Wait for video to be playable before starting timer
  await new Promise((resolve) => {
    if (video.readyState >= 3) {
      resolve();
    } else {
      video.addEventListener('canplay', resolve, { once: true });
    }
  });

  video.play().then(() => {
    video.muted = false;
  }).catch(() => {});

  // Render answers
  const container = $('#answers-container');
  container.innerHTML = '';
  game.answers.forEach((answer) => {
    const btn = document.createElement('button');
    btn.className = 'answer-btn';
    btn.textContent = answer;
    btn.addEventListener('click', () => handleAnswer(answer, btn));
    container.appendChild(btn);
  });

  startTimer();
  preloadUpcoming();
}

function handleAnswer(answer, btnElement) {
  if (answered) return;
  answered = true;
  stopTimer();

  const game = GAMES[currentQuestion];
  const correct = answer === game.name;
  const timeUsed = 10 - timeLeft;

  let points = 0;
  if (correct) {
    points = 100 + Math.round((timeLeft / 10) * 100);
    streak++;
    if (streak > bestStreak) bestStreak = streak;
    if (streak >= 3) points = Math.round(points * (1 + (streak - 2) * 0.25));
  } else {
    streak = 0;
  }

  score += points;
  updateScore();
  updateStreak();

  results.push({ game: game.name, answered: answer, correct, points, timeUsed });

  document.querySelectorAll('.answer-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.textContent === game.name) btn.classList.add('correct');
    else if (btn === btnElement && !correct) btn.classList.add('wrong');
  });

  showFeedback(correct, points, game.name);

  setTimeout(async () => {
    currentQuestion++;
    if (currentQuestion < GAMES.length) {
      await loadQuestion();
    } else {
      showResults();
    }
  }, 2500);
}

function handleTimeout() {
  if (answered) return;
  answered = true;

  const game = GAMES[currentQuestion];
  streak = 0;
  updateStreak();

  results.push({ game: game.name, answered: null, correct: false, points: 0, timeUsed: 10 });

  document.querySelectorAll('.answer-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.textContent === game.name) btn.classList.add('correct');
  });

  showFeedback(false, 0, game.name, true);

  setTimeout(async () => {
    currentQuestion++;
    if (currentQuestion < GAMES.length) {
      await loadQuestion();
    } else {
      showResults();
    }
  }, 2500);
}

function showFeedback(correct, points, gameName, timeout = false) {
  const overlay = $('#video-overlay');
  const content = $('#overlay-content');
  overlay.classList.remove('hidden');

  if (timeout) {
    overlay.className = 'video-overlay timeout';
    content.innerHTML = `
      <div class="feedback-icon">TIME'S UP</div>
      <div class="feedback-game">${gameName}</div>
    `;
  } else if (correct) {
    overlay.className = 'video-overlay correct';
    content.innerHTML = `
      <div class="feedback-icon">CORRECT</div>
      <div class="feedback-points">+${points} pts</div>
      ${streak >= 3 ? `<div class="feedback-streak">STREAK x${streak} BONUS!</div>` : ''}
    `;
  } else {
    overlay.className = 'video-overlay wrong';
    content.innerHTML = `
      <div class="feedback-icon">WRONG</div>
      <div class="feedback-game">${gameName}</div>
    `;
  }
}

function updateScore() {
  $('#score-value').textContent = score;
}

function updateStreak() {
  const badge = $('#streak-badge');
  if (streak >= 2) {
    badge.classList.remove('hidden');
    badge.textContent = `STREAK x${streak}`;
    badge.classList.add('pulse');
    setTimeout(() => badge.classList.remove('pulse'), 400);
  } else {
    badge.classList.add('hidden');
  }
}

// -- Results --
function showResults() {
  const video = $('#game-video');
  video.pause();

  const correctCount = results.filter(r => r.correct).length;
  const accuracy = Math.round((correctCount / GAMES.length) * 100);
  const avgTime = (results.reduce((s, r) => s + r.timeUsed, 0) / GAMES.length).toFixed(1);

  $('#results-score').innerHTML = `
    <div class="big-score">${score}</div>
    <div class="score-label">TOTAL SCORE</div>
    <div class="stats-row">
      <div class="stat"><div class="stat-value">${correctCount}/${GAMES.length}</div><div class="stat-label">Correct</div></div>
      <div class="stat"><div class="stat-value">${accuracy}%</div><div class="stat-label">Accuracy</div></div>
      <div class="stat"><div class="stat-value">${bestStreak}</div><div class="stat-label">Best Streak</div></div>
      <div class="stat"><div class="stat-value">${avgTime}s</div><div class="stat-label">Avg Time</div></div>
    </div>
  `;

  $('#results-breakdown').innerHTML = results.map((r) => {
    const game = GAMES.find(g => g.name === r.game);
    const steamUrl = `https://store.steampowered.com/app/${game.steamAppId}`;
    return `
    <a href="${steamUrl}" target="_blank" rel="noopener" class="result-row ${r.correct ? 'correct' : 'wrong'}">
      <span class="result-indicator">${r.correct ? '\u2713' : '\u2717'}</span>
      <span class="result-name">${r.game}<span class="steam-link">View on Steam</span></span>
      <span class="result-points">${r.correct ? '+' + r.points : '0'}</span>
    </a>`;
  }).join('');

  showScreen('results');
}

function generateShareText() {
  const correctCount = results.filter(r => r.correct).length;
  const squares = results.map(r => r.correct ? '\u{1F7E9}' : '\u{1F7E5}').join('');
  return `LoreMasters - Steam Quiz\n${squares}\n${correctCount}/${GAMES.length} | Score: ${score} | Streak: ${bestStreak}\nPlay at loremasters.com`;
}

// -- Preload first clip immediately on page load --
preloadClip(0);

// -- Event listeners --
$('#btn-start').addEventListener('click', () => {
  startGame();
});

$('#btn-retry').addEventListener('click', () => startGame());

$('#btn-share').addEventListener('click', () => {
  navigator.clipboard.writeText(generateShareText()).then(() => {
    $('#btn-share').textContent = 'COPIED!';
    setTimeout(() => { $('#btn-share').textContent = 'SHARE RESULTS'; }, 2000);
  });
});
