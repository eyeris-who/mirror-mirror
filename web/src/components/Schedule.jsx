import { useEffect, useReducer } from "react";
import { usePolling } from "../hooks/usePolling.js";

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const MAX_VISIBLE = 10;

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

  // Aim to fill MAX_VISIBLE rows. Always show every upcoming event that fits;
  // use leftover slots for the most-recently-ended events. Only when upcoming
  // events alone overflow do we drop some and keep just one ended for context.
  const past = all.filter((e) => e.past); // chronological
  const upcoming = all.filter((e) => !e.past);

  let nUpcoming;
  let nPast;
  if (upcoming.length > MAX_VISIBLE) {
    nPast = past.length ? 1 : 0;
    nUpcoming = MAX_VISIBLE - nPast;
  } else {
    nUpcoming = upcoming.length;
    nPast = Math.min(past.length, MAX_VISIBLE - nUpcoming);
  }

  const visible = [
    ...past.slice(past.length - nPast),
    ...upcoming.slice(0, nUpcoming),
  ];
  const hidden = all.length - visible.length;

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
