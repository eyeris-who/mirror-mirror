/**
 * Choose which rows to show in a fixed-height list (schedule, reminders).
 *
 * Aim to fill `max` rows: show every not-past item that fits, then use leftover
 * slots for the most-recently-past items. Only when the not-past items alone
 * overflow do we drop some and keep one past item for context.
 *
 * `items` must be sorted chronologically and each carry a boolean `.past`.
 */
export function pickVisible(items, max) {
  const past = items.filter((i) => i.past);
  const upcoming = items.filter((i) => !i.past);

  let nUpcoming;
  let nPast;
  if (upcoming.length > max) {
    nPast = past.length ? 1 : 0;
    nUpcoming = max - nPast;
  } else {
    nUpcoming = upcoming.length;
    nPast = Math.min(past.length, max - nUpcoming);
  }

  const visible = [
    ...past.slice(past.length - nPast),
    ...upcoming.slice(0, nUpcoming),
  ];
  return { visible, hidden: items.length - visible.length };
}
