import { usePolling } from "../hooks/usePolling.js";

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export default function Schedule() {
  const { data, error } = usePolling("/api/schedule", 5 * 60 * 1000);

  if (!data) {
    return (
      <div className="schedule schedule--muted">
        {error ? "Schedule unavailable" : "Loading schedule…"}
      </div>
    );
  }

  const events = data.events ?? [];
  const now = Date.now();

  return (
    <div className="schedule">
      <h2 className="schedule__title">Today's Events</h2>
      {events.length === 0 && (
        <div className="schedule--muted">Nothing scheduled</div>
      )}
      <ul className="schedule__list">
        {events.map((e) => {
          const past = e.end && new Date(e.end).getTime() < now;
          return (
            <li
              key={e.id}
              className={`schedule__item${past ? " schedule__item--past" : ""}`}
            >
              <span className="schedule__time">
                {e.allDay ? "all day" : TIME_FMT.format(new Date(e.start))}
              </span>
              <span className="schedule__body">
                <span className="schedule__event">{e.title}</span>
                {e.location && (
                  <span className="schedule__loc">{e.location}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
