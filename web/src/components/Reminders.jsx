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
  const { data } = usePolling("/api/reminders", 30 * 1000);
  const [, tick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const all = (data?.reminders ?? []).map((r) => ({
    ...r,
    past: new Date(r.at).getTime() < now, // overdue
  }));
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
