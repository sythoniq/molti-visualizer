# VM Memory Visualizer (React + plain CSS)

    npm install
    npm run dev

Load `trace.json` and your source file together ("Load trace + source", or drop both on the page).
Keys: ← / → step, space play/pause.

## Reading a step
Each step is one VM instruction:
- **Stack Before → After**: green = new slot, amber = changed, red/struck = removed.
- **Heap**: objects after the step. Glowing green = just allocated; bold border = on the stack right now;
  struck red = freed in this step. Hover a pointer on the stack to find its object.
- **Code**: blue = line running, green = the next line.
- **Globals / Console**: derived from the trace (DEFINE_GLOBAL, OP_PRINT).
- The chips under the description summarise what changed in plain English.

## Trace format expected
NDJSON, one event per line: ALLOC, EXECUTE (state before), RESULT (state after), FREE (+reason), optional GC / SOURCE.
Older traces without RESULT rows still work.

## Files
- `src/parse.js`   reads NDJSON
- `src/replay.js`  groups events into steps; derives names, globals, console output, change chips
- `src/App.jsx`    panels and controls
