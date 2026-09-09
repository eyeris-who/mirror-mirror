import { useEffect, useReducer } from "react";
import { usePolling } from "../hooks/usePolling.js";
import { pickVisible } from "../lib/pickVisible.js";

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "short" });

const MAX_VISIBLE = 5;

function when(d) {
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? TIME_FMT.format(d)
    : `${DAY_FMT.format(d)} ${TIME_FMT.format(d)}`;
}

/** Pending + overdue reminders, formatted like the schedule. */
export default function Reminders() {
  const { data } = usePolling("/api/reminders", 15 * 1000);
  const [renders, tick] = useReducer((x) => x + 1, 0);

  const now = Date.now();
  const all = (data?.reminders ?? []).map((r) => ({
    ...r,
    past: new Date(r.at).getTime() < now, // overdue
  }));

  // Re-render right when the next reminder crosses into "overdue". Cap the wait
  // at a minute so a far-off reminder locks onto its exact second only when it's
  // close (and background-timer drift can't matter). `renders` in the deps keeps
  // the chain going after each tick.
  const nextCross = all
    .filter((r) => !r.past)
    .reduce((min, r) => Math.min(min, new Date(r.at).getTime()), Infinity);
  useEffect(() => {
    const untilCross = Number.isFinite(nextCross)
      ? Math.max(nextCross - Date.now(), 0) + 250
      : Infinity;
    const t = setTimeout(tick, Math.min(untilCross, 60 * 1000));
    return () => clearTimeout(t);
  }, [nextCross, renders]);

  if (!all.length) return null;

  const { visible, hidden } = pickVisible(all, MAX_VISIBLE);

  return (
    <div className="reminders">
      <h2 className="reminders__title">Reminders</h2>
      <ul className="reminders__list">
        {visible.map((r) => (
          <li
            className={`reminders__item${r.past ? " reminders__item--past" : ""}`}
            key={r.id}
          >
            <span className="reminders__time">{when(new Date(r.at))}</span>
            <span className="reminders__text">{r.text}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && <div className="schedule--muted">+{hidden} more</div>}
    </div>
  );
}
