import { useEffect, useReducer } from "react";
import { usePolling } from "../hooks/usePolling.js";
import { pickVisible } from "../lib/pickVisible.js";

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const MAX_VISIBLE = 5;

function humanDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function Schedule() {
  // Poll the server every 2 min (picks up new/changed events + the day rolling
  // over at midnight — "today" is computed server-side per request).
  const { data, error } = usePolling("/api/schedule", 2 * 60 * 1000);
  const [renders, tick] = useReducer((x) => x + 1, 0);

  const now = Date.now();
  const events = data?.events ?? [];

  // Re-render right when the next event ends (greys out), capped at a minute so
  // a far-off event locks on only when it's close. `renders` keeps the chain
  // going after each tick.
  const nextCross = events
    .map((e) => new Date(e.end || e.start).getTime())
    .filter((t) => t > now)
    .reduce((min, t) => Math.min(min, t), Infinity);
  useEffect(() => {
    const untilCross = Number.isFinite(nextCross)
      ? Math.max(nextCross - Date.now(), 0) + 250
      : Infinity;
    const t = setTimeout(tick, Math.min(untilCross, 60 * 1000));
    return () => clearTimeout(t);
  }, [nextCross, renders]);

  if (!data) {
    return (
      <div className="schedule schedule--muted">
        {error ? "Schedule unavailable" : "Loading schedule…"}
      </div>
    );
  }

  const all = events.map((e) => ({
    ...e,
    past: new Date(e.end || e.start).getTime() < now,
  }));
  const { visible, hidden } = pickVisible(all, MAX_VISIBLE);

  return (
    <div className="schedule">
      <h2 className="schedule__title">
        Today&apos;s Events{all.length > MAX_VISIBLE ? ` · ${all.length}` : ""}
      </h2>

      {all.length === 0 && (
        <div className="schedule--muted">Nothing scheduled</div>
      )}

      <ul className="schedule__list">
        {visible.map((e) => {
          const start = new Date(e.start);
          const durMs = e.end ? new Date(e.end).getTime() - start.getTime() : 0;
          return (
            <li
              key={e.id}
              className={`schedule__item${e.past ? " schedule__item--past" : ""}`}
            >
              <span className="schedule__time">
                {e.allDay ? "all day" : TIME_FMT.format(start)}
              </span>
              <span className="schedule__dur">
                {!e.allDay && durMs > 0 ? humanDur(durMs) : ""}
              </span>
              <span className="schedule__event">
                {e.title}
                {e.location && (
                  <span className="schedule__loc"> · {e.location}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && <div className="schedule--muted">+{hidden} more</div>}
    </div>
  );
}
