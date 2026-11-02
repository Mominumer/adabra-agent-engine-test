// When the overnight runner may start, on this machine's clock. A night runs from one first-start time to the next, so a run after the
// window ended still counts against the night it fell in, whichever calendar day that is.
export const FIRST_START = Object.freeze({ hour: 0, minute: 30 });
export const LAST_START = Object.freeze({ hour: 5, minute: 0 });
export const FINISH_BY = Object.freeze({ hour: 6, minute: 30 });

const onDayOf = (now, { hour, minute }) => {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

export const inStartWindow = (now) => now >= onDayOf(now, FIRST_START) && now <= onDayOf(now, LAST_START);
export const finishBy = (now) => onDayOf(now, FINISH_BY);

// The start of the night this moment belongs to.
export function nightStart(now) {
  const today = onDayOf(now, FIRST_START);
  if (now >= today) return today;
  const d = new Date(today);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function nextNightStart(now) {
  const d = new Date(nightStart(now));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// A night's name: the calendar date its window falls on.
export function nightLabel(now) {
  const d = new Date(nightStart(now));
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
