// Generates 3 plausible wrong answers for each game based on shared Steam tags/genres.

function generateWrongAnswers(correctGame, allGames, count = 3) {
  const correctTags = new Set(correctGame.tags || []);

  // Score other games by tag overlap
  const candidates = allGames
    .filter(g => g.appId !== correctGame.appId)
    .map(g => {
      const gameTags = new Set(g.tags || []);
      let overlap = 0;
      for (const tag of gameTags) {
        if (correctTags.has(tag)) overlap++;
      }
      return { name: g.name, overlap };
    })
    .filter(g => g.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  // Take top candidates, shuffle slightly for variety
  const top = candidates.slice(0, count * 3);
  const shuffled = top.sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, count).map(g => g.name);

  // If not enough candidates from tag matching, fill with random games
  if (picks.length < count) {
    const remaining = allGames
      .filter(g => g.appId !== correctGame.appId && !picks.includes(g.name))
      .sort(() => Math.random() - 0.5);

    while (picks.length < count && remaining.length > 0) {
      picks.push(remaining.pop().name);
    }
  }

  return picks;
}

// Build the full answers array with correct answer in random position
function buildAnswers(correctName, wrongAnswers) {
  const answers = [...wrongAnswers];
  const insertPos = Math.floor(Math.random() * (answers.length + 1));
  answers.splice(insertPos, 0, correctName);
  return answers;
}

export { generateWrongAnswers, buildAnswers };
