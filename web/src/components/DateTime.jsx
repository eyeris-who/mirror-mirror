import { useEffect, useState } from "react";

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const pad = (n) => String(n).padStart(2, "0");

export default function DateTime() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const h24 = now.getHours();
  const h = h24 % 12 || 12;
  const m = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const ampm = h24 < 12 ? "AM" : "PM";

  return (
    <div className="datetime">
      <div className="datetime__time">
        {h}:{m}
        <span className="datetime__seconds">{s}</span>
        <span className="datetime__ampm">{ampm}</span>
      </div>
      <div className="datetime__date">{DATE_FMT.format(now)}</div>
    </div>
  );
}
