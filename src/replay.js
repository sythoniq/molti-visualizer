// Turns the raw event log into "steps" — one per VM instruction.
//
//   EXECUTE  → stack/frames BEFORE the instruction
//   ALLOC/FREE rows that follow it belong to that instruction
//   RESULT   → stack/frames AFTER the instruction
//
// Extra steps: "load" (objects the compiler allocated before running) and
// "cleanup" (FREEs after the program ended). Old traces without RESULT rows
// still work: the "after" state is taken from the next EXECUTE row.

export const short = (id) => id.replace(/^0x/, '').slice(-10);

export function fmtValue(v, ctx, quote = true) {
  if (!v) return '';
  if (v.type === 'nil') return 'nil';
  if (v.type === 'bool' || v.type === 'num') return String(v.value);
  const s = v.value ?? ctx.strings.get(v.id);
  if (s !== undefined) return quote ? `"${s}"` : s;
  return ctx.names.get(v.id) ?? `object ${short(v.id)}`;
}

const sameVal = (a, b) => a.type === b.type && a.value === b.value && a.id === b.id;

export function buildSteps(events) {
  const steps = [];
  const warnings = [];
  const heap = new Map();
  const names = new Map();     // object id -> "foo()" / "<script>"
  const strings = new Map();   // object id -> string contents
  const globals = new Map();   // global name -> value
  const output = [];
  let source = null;
  let open = null;             // EXECUTE waiting for its RESULT
  let load = null;             // allocations made before the first instruction
  let started = false;
  let last = { stack: [], frames: [] };

  const mk = (kind, props) => ({
    kind, instruction: null, description: '', line: null, nextLine: null,
    before: last.stack, after: last.stack, framesBefore: last.frames, framesAfter: last.frames,
    allocs: [], frees: [], ...props,
  });

  const learn = (stack, frames) => {
    for (const v of stack) if (v.type === 'obj' && v.value !== undefined) strings.set(v.id, v.value);
    for (const f of frames) {
      const callee = stack[f.stackBase];
      if (callee && callee.type === 'obj') names.set(callee.id, f.function === '<script>' ? '<script>' : `${f.function}()`);
    }
  };

  const finalize = (s) => {
    s.heap = [...heap.values()];
    s.heapBytes = s.heap.reduce((n, h) => n + h.size, 0);
    s.names = new Map(names);
    s.strings = new Map(strings);
    s.globals = [...globals].map(([name, value]) => ({ name, value }));
    s.output = [...output];
    s.nextLine = s.framesAfter.length ? s.framesAfter[s.framesAfter.length - 1].line : null;
    s.index = steps.length;
    steps.push(s);
    last = { stack: s.after, frames: s.framesAfter };
  };

  const closeOpen = (nextStack, nextFrames) => {
    if (!open) return;
    if (!open.after) { open.after = nextStack ?? open.before; open.framesAfter = nextFrames ?? open.framesBefore; }
    learn(open.after, open.framesAfter);
    finalize(open);
    open = null;
  };

  const finishLoad = () => {
    if (!load) return;
    const n = load.allocs.length;
    load.description = `Before running, the compiler created ${n} object${n === 1 ? '' : 's'} on the heap (functions and strings from your source).`;
    finalize(load);
    load = null;
  };

  for (const ev of events) {
    switch (ev.action) {
      case 'SOURCE': source = ev.text; break;

      case 'ALLOC': {
        const obj = { id: ev.id, type: ev.type, size: ev.size };
        heap.set(ev.id, obj);
        if (open) open.allocs.push(obj);
        else if (!started) { load ??= mk('load', { title: 'LOAD' }); load.allocs.push(obj); }
        else finalize(mk('alloc', { title: 'ALLOC', description: `Allocated a ${obj.type} (${obj.size} B)`, allocs: [obj] }));
        break;
      }

      case 'FREE': {
        const obj = heap.get(ev.id);
        if (!obj) {
          warnings.push(`Ignored FREE of ${short(ev.id)}: it isn't a live tracked object (duplicate FREE, or it was allocated before tracing started).`);
          break;
        }
        heap.delete(ev.id);
        const freed = { ...obj, reason: ev.reason };
        if (open) open.frees.push(freed);
        else {
          const why = ev.reason === 'shutdown' ? 'program exit cleanup' : 'garbage collected';
          finalize(mk('cleanup', { title: 'FREE', description: `Freed a ${obj.type} (${obj.size} B): ${why}`, frees: [freed] }));
        }
        break;
      }

      case 'EXECUTE': {
        closeOpen(ev.stack, ev.frames);
        if (!started) { started = true; finishLoad(); }
        learn(ev.stack, ev.frames);
        const top = ev.stack[ev.stack.length - 1];
        if ((ev.instruction === 'OP_DEFINE_GLOBAL' || ev.instruction === 'OP_SET_GLOBAL') && top) {
          const m = /global '([^']+)'/.exec(ev.description || '');
          if (m) globals.set(m[1], top);
        }
        if (ev.instruction === 'OP_PRINT' && top) output.push(fmtValue(top, { names, strings }, false));
        open = mk('exec', {
          title: ev.instruction.replace('OP_', ''), instruction: ev.instruction,
          description: ev.description || ev.instruction, line: ev.line,
          before: ev.stack, after: null, framesBefore: ev.frames, framesAfter: null,
        });
        break;
      }

      case 'RESULT':
        if (open) { open.after = ev.stack; open.framesAfter = ev.frames; closeOpen(); }
        break;

      case 'GC':
        finalize(mk('gc', { title: 'GC', description: `Garbage collector ${ev.phase} (${ev.bytes} B in use)` }));
        break;

      default: break;
    }
  }
  closeOpen(null, null);
  finishLoad();
  return { steps, warnings, source };
}

// Plain-English "what changed" chips for a step.
export function summarize(s) {
  const chips = [];
  if (s.kind === 'exec') {
    const ctx = { names: s.names, strings: s.strings };
    const b = s.before, a = s.after;
    let p = 0;
    while (p < b.length && p < a.length && sameVal(b[p], a[p])) p++;
    const popped = b.slice(p), pushed = a.slice(p);
    if (popped.length) chips.push({ k: 'pop', t: `removed from stack: ${popped.map((v) => fmtValue(v, ctx)).join(', ')}` });
    if (pushed.length) chips.push({ k: 'push', t: `added to stack: ${pushed.map((v) => fmtValue(v, ctx)).join(', ')}` });
    if (!popped.length && !pushed.length) chips.push({ k: 'none', t: 'stack unchanged' });
    if (s.framesAfter.length > s.framesBefore.length) chips.push({ k: 'frame', t: `entered ${s.framesAfter[s.framesAfter.length - 1].function}` });
    if (s.framesAfter.length < s.framesBefore.length) {
      const back = s.framesAfter[s.framesAfter.length - 1];
      chips.push({ k: 'frame', t: back ? `returned to ${back.function}` : 'program finished' });
    }
    if (s.instruction === 'OP_PRINT') chips.push({ k: 'out', t: `printed ${s.output[s.output.length - 1]}` });
  }
  for (const o of s.allocs) chips.push({ k: 'alloc', t: `allocated ${o.type} (${o.size} B)` });
  for (const o of s.frees) chips.push({ k: 'free', t: `freed ${o.type} (${o.size} B)` });
  return chips;
}
