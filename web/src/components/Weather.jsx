import { usePolling } from "../hooks/usePolling.js";

// Minimal glyph set. Swap for SVG / a weather-icon font later.
const GLYPH = {
  sunny: "☀️",
  "mostly-sunny": "🌤️",
  "partly-cloudy": "⛅",
  cloudy: "☁️",
  fog: "🌫️",
  drizzle: "🌦️",
  rain: "🌧️",
  sleet: "🌨️",
  snow: "❄️",
  thunder: "⛈️",
};

export default function Weather() {
  const { data, error } = usePolling("/api/weather", 30 * 60 * 1000);

  const place = data?.place;
  const placeText = place
    ? [place.name, place.admin1].filter(Boolean).join(", ")
    : null;

  return (
    <div className="weather">
      <div className="weather__head">
        <span className="weather__label">Weather</span>
        {placeText && (
          <span className="weather__place">
            {placeText}
            <span className="weather__pin">📍</span>
          </span>
        )}
      </div>

      {!data ? (
        <div className="weather--muted">
          {error ? "Weather unavailable" : "Loading weather…"}
        </div>
      ) : (
        <div className="weather__list">
          {data.days.map((d) => (
            <div className="weather__row" key={d.date}>
              <span className="weather__day">{d.day}</span>
              <span className="weather__glyph">{GLYPH[d.icon] ?? "•"}</span>
              <span className="weather__cond">{d.text}</span>
              <span className="weather__temps">
                <span className="weather__hi">
                  {d.high}
                  {data.unit}
                </span>
                <span className="weather__lo">
                  {d.low}
                  {data.unit}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
