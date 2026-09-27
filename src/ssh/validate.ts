// Rejects a value that would let serialize() emit a directive we didn't
// intend: a newline starts a new (attacker-controlled) directive line, `\r`
// survives into the file even though our own parse() strips it back out.
export function isValidFieldValue(value: string): boolean {
  return !/[\n\r]/.test(value);
}

// A name with whitespace serializes as multiple patterns; an empty name
// serializes as a bare "Host" line whose directives attach to the prior
// host; a leading '-' is read as an ssh option, not a hostname, by both
// real ssh and mssh's own argv scanning.
export function isValidHostName(name: string): boolean {
  return name !== "" && !/\s/.test(name) && !name.startsWith("-");
}

// Intersection of three sinks' rules (config text, ssh argv, filename) —
// matches isValidKeyFilename's class. Applied only to newly typed aliases;
// isValidHostName is otherwise permissive for configs that already exist.
export function isValidNewHostName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) && !name.startsWith("-");
}

// ssh rejects out-of-range ports only at connect time, after the value is
// already sealed into the config — reject here instead.
export function isValidPort(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}
