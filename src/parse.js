// Your tracer writes NDJSON (one JSON object per line), not a single JSON document.
// It also emits unescaped quotes inside "description" (e.g. Define global variable "fib"),
// so we repair that field when a line fails to parse. (Better: fix it in trace.c, see README.)
function tryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function repairDescription(line) {
  return line.replace(/"description":"(.*?)","stack"/, (_, d) =>
    '"description":"' + d.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '","stack"');
}

export function parseTrace(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const arr = tryParse(trimmed);
    if (arr) return { events: arr, errors: [] };
  }
  const events = [];
  const errors = [];
  trimmed.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const ev = tryParse(line) ?? tryParse(repairDescription(line));
    if (ev) events.push(ev); else errors.push(i + 1);
  });
  return { events, errors };
}
