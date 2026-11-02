// For `status`: how the real review has done so far, on real commits. Under REVIEW_ENGINE=shadow this is the shadow's record, which is why it
// is here. Counts and estimates only, so it can be pasted anywhere: what a review said is in the service's log and goes no further.
export function reviewRunLines({ runs, commits, cost, turns, ms, groups }) {
  if (!runs) return [];
  const verdict = (state) => groups.filter((g) => g.outcome === 'valid' && g.state === state).reduce((sum, g) => sum + g.n, 0);
  const others = groups.filter((g) => g.outcome !== 'valid');
  const noResult = others.reduce((sum, g) => sum + g.n, 0);
  const why = others.length ? ` (${others.map((g) => `${g.outcome} ${g.n}`).join(', ')})` : '';
  return [
    `real review results on real commits: ${runs} run(s) on ${commits} commit(s): ${verdict('success')} pass, ${verdict('failure')} fail, ${noResult} no result${why}`,
    `  estimated cost $${(cost ?? 0).toFixed(2)} (the CLI's estimate, not a bill); about ${Math.round((turns ?? 0) / runs)} turn(s) and ${Math.round((ms ?? 0) / runs / 1000)} s a run`,
  ];
}
