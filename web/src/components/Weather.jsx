import { usePolling } from "../hooks/usePolling.js";

// Minimal glyph set. Swap for SVG/weather-icons font later.
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

function Line({ glyph, temp, unit, text, prefix }) {
  return (
    <div className="weather__line">
      <span className="weather__glyph">{GLYPH[glyph] ?? "•"}</span>
      <span className="weather__temp">
        {temp}
        {unit}
      </span>
      <span className="weather__text">
        {prefix ? `${prefix} — ` : ""}
        {text}
      </span>
    </div>
  );
}

export default function Weather() {
  const { data, error } = usePolling("/api/weather", 10 * 60 * 1000);

  if (!data) {
    return (
      <div className="weather weather--muted">
        {error ? "Weather unavailable" : "Loading weather…"}
      </div>
    );
  }

  const { current, forecast, unit } = data;

  return (
    <div className="weather">
      <Line
        glyph={current.icon}
        temp={current.temperature}
        unit={unit}
        text={current.text}
      />
      {forecast && (
        <Line
          glyph={forecast.icon}
          temp={forecast.temperature}
          unit={unit}
          text={forecast.text}
          prefix={`${forecast.hour % 12 || 12}${forecast.hour < 12 ? "am" : "pm"} ${forecast.label}`}
        />
      )}
    </div>
  );
}
