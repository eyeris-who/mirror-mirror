import DateTime from "./components/DateTime.jsx";
import Weather from "./components/Weather.jsx";
import Schedule from "./components/Schedule.jsx";

export default function App() {
  return (
    <main className="mirror">
      <section className="col col--left">
        <DateTime />
        <Weather />
      </section>

      <section className="col col--right">
        <Schedule />
      </section>
    </main>
  );
}
