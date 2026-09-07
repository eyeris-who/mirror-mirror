// Whether the mirror is showing anything. "Asleep" = the page fades to black;
// the server, voice service, and any music keep running.
let on = true;

export const isOn = () => on;
export const setOn = (v) => {
  on = Boolean(v);
  return on;
};
