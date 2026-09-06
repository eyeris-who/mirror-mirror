import { useEffect, useState } from "react";

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

export default function DateTime() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="datetime">
      <div className="datetime__time">{TIME_FMT.format(now)}</div>
      <div className="datetime__date">{DATE_FMT.format(now)}</div>
    </div>
  );
}
