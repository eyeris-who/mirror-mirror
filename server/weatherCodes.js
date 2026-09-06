// WMO weather interpretation codes used by Open-Meteo.
// https://open-meteo.com/en/docs  ->  "Weather variable documentation"
const CODES = {
  0: { text: "Clear sky", icon: "sunny" },
  1: { text: "Mainly clear", icon: "mostly-sunny" },
  2: { text: "Partly cloudy", icon: "partly-cloudy" },
  3: { text: "Overcast", icon: "cloudy" },
  45: { text: "Fog", icon: "fog" },
  48: { text: "Rime fog", icon: "fog" },
  51: { text: "Light drizzle", icon: "drizzle" },
  53: { text: "Drizzle", icon: "drizzle" },
  55: { text: "Heavy drizzle", icon: "drizzle" },
  56: { text: "Freezing drizzle", icon: "sleet" },
  57: { text: "Freezing drizzle", icon: "sleet" },
  61: { text: "Light rain", icon: "rain" },
  63: { text: "Rain", icon: "rain" },
  65: { text: "Heavy rain", icon: "rain" },
  66: { text: "Freezing rain", icon: "sleet" },
  67: { text: "Freezing rain", icon: "sleet" },
  71: { text: "Light snow", icon: "snow" },
  73: { text: "Snow", icon: "snow" },
  75: { text: "Heavy snow", icon: "snow" },
  77: { text: "Snow grains", icon: "snow" },
  80: { text: "Light showers", icon: "rain" },
  81: { text: "Showers", icon: "rain" },
  82: { text: "Violent showers", icon: "rain" },
  85: { text: "Snow showers", icon: "snow" },
  86: { text: "Snow showers", icon: "snow" },
  95: { text: "Thunderstorm", icon: "thunder" },
  96: { text: "Thunderstorm, hail", icon: "thunder" },
  99: { text: "Thunderstorm, hail", icon: "thunder" },
};

export function describeCode(code) {
  return CODES[code] ?? { text: "Unknown", icon: "cloudy" };
}
