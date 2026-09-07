import { useEffect, useReducer } from "react";
import { usePolling } from "../hooks/usePolling.js";

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const MAX_VISIBLE = 8;

function humanDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function Schedule() {
  // Poll the server every 2 min (picks up new/changed events + the day rolling
  // over at midnight — "today" is computed server-side per request). Re-render
  // every minute so events grey out the moment they end, without new data.
  const { data, error } = usePolling("/api/schedule", 2 * 60 * 1000);
  const [, tick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!data) {
    return (
      <div className="schedule schedule--muted">
        {error ? "Schedule unavailable" : "Loading schedule…"}
      </div>
    );
  }

  const now = Date.now();
  const all = (data.events ?? []).map((e) => ({
    ...e,
    past: new Date(e.end || e.start).getTime() < now,
  }));

  // Too many to fit? Keep one just-finished event for context, then upcoming.
  let visible = all;
  let hidden = 0;
  if (all.length > MAX_VISIBLE) {
    const past = all.filter((e) => e.past);
    const upcoming = all.filter((e) => !e.past);
    visible = [...past.slice(-1), ...upcoming].slice(0, MAX_VISIBLE);
    hidden = all.length - visible.length;
  }

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
