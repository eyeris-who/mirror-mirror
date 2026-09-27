import { publish } from "./events.js";

// Whether the mirror is showing anything. "Asleep" = the page fades to black;
// the server, voice service, and any music keep running.
let on = true;

export const isOn = () => on;
export const setOn = (v) => {
  const next = Boolean(v);
  if (next !== on) {
    on = next;
    publish("display", { on });
  }
  return on;
};
