// "2 hours ago", in sentence case. Small and predictable on purpose.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

export function relativeTime(then: number, now = Date.now()): string {
  const d = Math.max(0, now - then);
  if (d < MIN) return 'Just now';
  if (d < HOUR) return plural(Math.floor(d / MIN), 'minute');
  if (d < DAY) return plural(Math.floor(d / HOUR), 'hour');
  if (d < 2 * DAY) return 'Yesterday';
  if (d < 7 * DAY) return plural(Math.floor(d / DAY), 'day');
  if (d < 30 * DAY) return plural(Math.floor(d / (7 * DAY)), 'week');
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
}

/** Show a path with the home directory folded to ~. */
export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
}
