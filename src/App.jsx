import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseTrace } from './parse.js';
import { buildSteps, summarize, fmtValue, short } from './replay.js';

const hue = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const colorOf = (id) => `hsl(${hue(id)} 65% 62%)`;
const sameVal = (a, b) => a && b && a.type === b.type && a.value === b.value && a.id === b.id;

function Val({ v, snap, hovered, setHovered }) {
	if (v.type === 'obj') {
		const str = v.value ?? snap.strings.get(v.id);
		const label = str !== undefined ? `"${str}"` : snap.names.get(v.id) ?? 'object';
		return (
			<span className={'ptr' + (hovered === v.id ? ' hot' : '')} style={{ '--c': colorOf(v.id) }}
				title={`heap object ${v.id}`}
				onMouseEnter={() => setHovered(v.id)} onMouseLeave={() => setHovered(null)}>
				→ {label}
			</span>
		);
	}
	if (v.type === 'nil') return <span className="lit nil">nil</span>;
	if (v.type === 'bool') return <span className="lit bool">{String(v.value)}</span>;
	return <span className="lit num">{v.value}</span>;
}

function StackColumn({ title, stack, frames, other, mode, snap, hovered, setHovered }) {
	const frameOf = (idx) => { let f = 0; frames.forEach((fr, k) => { if (idx >= fr.stackBase) f = k; }); return f; };
	const rows = stack.map((v, idx) => ({ v, idx })).reverse();
	return (
		<div className="stack-col">
			<h3>{title} <small>{stack.length} slot{stack.length === 1 ? '' : 's'}</small></h3>
			<div className="stack">
				{rows.length === 0 && <div className="empty">empty</div>}
				{rows.map(({ v, idx }, r) => {
					const fi = frameOf(idx);
					const fr = frames[fi];
					const rel = fr ? idx - fr.stackBase : idx;
					const isBase = fr && fr.stackBase === idx;
					let status = '';
					if (idx >= other.length) status = mode === 'after' ? 'new' : 'gone';
						else if (!sameVal(v, other[idx])) status = 'changed';
					return (
						<React.Fragment key={idx}>
							<div className={'slot ' + status} style={{ '--depth': fi }}>
								<span className="idx">{idx}</span>
								<Val v={v} snap={snap} hovered={hovered} setHovered={setHovered} />
								<span className="rel">{rel === 0 && fr ? 'callee' : fr ? `slot ${rel}` : ''}</span>
								{r === 0 && <span className="top">top</span>}
							</div>
							{isBase && <div className="frame-tag" style={{ '--depth': fi }}>▲ {fr.function === '<script>' ? 'script' : fr.function + '()'}</div>}
						</React.Fragment>
					);
				})}
			</div>
		</div>
	);
}

function StackPanel({ snap, hovered, setHovered }) {
	return (
		<section className="panel">
			<h2>Stack</h2>
			<div className="stack-pair">
				<StackColumn title="Before" stack={snap.before} frames={snap.framesBefore} other={snap.after} mode="before" snap={snap} hovered={hovered} setHovered={setHovered} />
				<div className="arrow" aria-hidden>→</div>
				<StackColumn title="After" stack={snap.after} frames={snap.framesAfter} other={snap.before} mode="after" snap={snap} hovered={hovered} setHovered={setHovered} />
			</div>
		</section>
	);
}

function HeapPanel({ snap, hovered, setHovered }) {
	const onStack = new Set(snap.after.filter((v) => v.type === 'obj').map((v) => v.id));
	const fresh = new Set(snap.allocs.map((o) => o.id));
	const label = (h) => {
		const s = snap.strings.get(h.id);
		return s !== undefined ? `"${s}"` : snap.names.get(h.id) ?? h.type;
	};
	return (
		<section className="panel">
			<h2>Heap <small>{snap.heap.length} object{snap.heap.length === 1 ? '' : 's'} · {snap.heapBytes} B</small></h2>
			<div className="heap">
				{snap.heap.length === 0 && snap.frees.length === 0 && <div className="empty">nothing allocated</div>}
				{snap.heap.map((h) => (
					<div key={h.id}
						className={['block', onStack.has(h.id) ? 'onstack' : '', fresh.has(h.id) ? 'fresh' : '', hovered === h.id ? 'hot' : ''].join(' ')}
						style={{ '--c': colorOf(h.id), '--w': Math.min(240, 100 + h.size * 1.2) + 'px' }}
						title={`${h.id}${onStack.has(h.id) ? ' (on the stack right now)' : ''}`}
						onMouseEnter={() => setHovered(h.id)} onMouseLeave={() => setHovered(null)}>
						<b>{label(h)}</b>
						<span>{h.type} · {h.size} B</span>
						<small>{short(h.id)}</small>
					</div>
				))}
				{snap.frees.map((h) => (
					<div key={'f' + h.id} className="block freed" style={{ '--c': colorOf(h.id), '--w': '140px' }}>
						<b>{snap.strings.get(h.id) !== undefined ? `"${snap.strings.get(h.id)}"` : snap.names.get(h.id) ?? h.type}</b>
						<span>freed · {h.size} B</span>
						<small>{h.reason === 'shutdown' ? 'program exit' : 'garbage collected'}</small>
					</div>
				))}
			</div>
		</section>
	);
}

function GlobalsPanel({ snap, hovered, setHovered }) {
	return (
		<section className="panel">
			<h2>Globals</h2>
			{snap.globals.length === 0 ? <div className="empty">none defined yet</div> : (
				<table className="globals"><tbody>
					{snap.globals.map((g) => (
						<tr key={g.name}><td>{g.name}</td><td>=</td><td><Val v={g.value} snap={snap} hovered={hovered} setHovered={setHovered} /></td></tr>
					))}
				</tbody></table>
			)}
		</section>
	);
}

function ConsolePanel({ snap }) {
	const printing = snap.instruction === 'OP_PRINT';
	return (
		<section className="panel">
			<h2>Console output</h2>
			<pre className="console">
				{snap.output.length === 0 ? <span className="dim">(nothing printed yet)</span>
					: snap.output.map((l, i) => <div key={i} className={printing && i === snap.output.length - 1 ? 'new' : ''}>{l}</div>)}
			</pre>
		</section>
	);
}

function CodePanel({ snap, source }) {
	const ref = useRef(null);
	useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }); }, [snap.index]);
	const cur = snap.line, next = snap.nextLine;
	return (
		<section className="panel">
			<h2>Code <small>{cur != null ? `running line ${cur}` : ''}{next != null && next !== cur ? ` → next line ${next}` : ''}</small></h2>
			{!source ? <div className="source-none">Drop your source file (.mo) on this page to see the code.</div> : (
				<pre className="source">
					{source.split('\n').map((t, k) => {
						const n = k + 1;
						return (
							<div key={k} ref={n === cur ? ref : null} className={n === cur ? 'cur' : n === next ? 'next' : ''}>
								<span>{n}</span>{t || ' '}
							</div>
						);
					})}
				</pre>
			)}
		</section>
	);
}

function FramesPanel({ snap }) {
	const frames = snap.framesAfter;
	return (
		<section className="panel">
			<h2>Call stack</h2>
			{frames.length === 0 ? <div className="empty">no active calls</div> : (
				<ol className="frames">
					{[...frames].map((f, i) => ({ f, i })).reverse().map(({ f, i }, k) => (
						<li key={i} className={(k === 0 ? 'cur ' : '') + (i >= snap.framesBefore.length ? 'new' : '')}>
							{f.function === '<script>' ? 'script (top level)' : f.function + '()'} <small>next line {f.line} · base {f.stackBase}</small>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

function LogPanel({ steps, pos, setPos }) {
	const cur = useRef(null);
	useEffect(() => { cur.current?.scrollIntoView({ block: 'nearest' }); }, [pos]);
	return (
		<section className="panel log-panel">
			<h2>Execution log <small>click a step to jump</small></h2>
			<ol className="log">
				{steps.map((s, k) => (
					<li key={k} ref={k === pos ? cur : null} className={k === pos ? 'cur' : k < pos ? 'done' : ''} onClick={() => setPos(k)}>
						<span className="n">{k + 1}</span>
						<span className={'badge ' + s.kind}>{s.title}</span>
						<span className="d">{s.description}</span>
						{s.line != null && <small>L{s.line}</small>}
					</li>
				))}
			</ol>
		</section>
	);
}

export default function App() {
	const [model, setModel] = useState({ steps: [], warnings: [], source: null, parseErrors: [] });
	const [source, setSource] = useState('');
	const [pos, setPos] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState(700);
	const [hovered, setHovered] = useState(null);
	const [sourceName, setSourceName] = useState(null)
	const [traceName, setTraceName] = useState(null)

	const loadTrace = (text) => {
		const r = parseTrace(text);
		const m = buildSteps(r.events);
		setModel({ ...m, parseErrors: r.errors });
		if (m.source) setSource(m.source);
		setPos(0); setPlaying(false);
	};
	const loadFiles = async (files) => {
		for (const f of files) {
			const text = await f.text();
			if (/\.(json|ndjson|jsonl)$/i.test(f.name) || text.trimStart().startsWith('{"step"')) { loadTrace(text); setTraceName(f.name); }
			else { setSource(text); setSourceName(f.name); }
		}
	};

	useEffect(() => {
		fetch('./sample.trace.json').then((r) => r.text()).then(loadTrace).catch(() => {});
		fetch('./sample.mo').then((r) => (r.ok ? r.text() : '')).then((t) => t && setSource(t)).catch(() => {});
	}, []);

	const { steps, warnings, parseErrors } = model;
	const snap = steps[pos];
	const last = steps.length - 1;
	const chips = useMemo(() => (snap ? summarize(snap) : []), [snap]);

	useEffect(() => {
		if (!playing) return;
		if (pos >= last) { setPlaying(false); return; }
		const t = setTimeout(() => setPos((p) => Math.min(p + 1, last)), speed);
		return () => clearTimeout(t);
	}, [playing, pos, last, speed]);

	useEffect(() => {
		const onKey = (e) => {
			if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
			if (e.key === 'ArrowRight') setPos((p) => Math.min(p + 1, last));
			if (e.key === 'ArrowLeft') setPos((p) => Math.max(p - 1, 0));
			if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [last]);

	return (
		<div>
			<header>
				<h1>Molti Visulizer</h1>
				<label className="file">Load trace
					<input type="file" accept=".json,.ndjson,.jsonl,.txt"
						onChange={(e) => { const f = e.target.files[0]; if (f) f.text().then((t) => { loadTrace(t); setTraceName(f.name); }); e.target.value = ''; }} />
				</label>
				<label className="file">Load source
					<input type="file"
						onChange={(e) => { const f = e.target.files[0]; if (f) f.text().then((t) => { setSource(t); setSourceName(f.name); }); e.target.value = ''; }} />
				</label>
				<span className="names">{traceName}{source ? ` · ${sourceName}` : ''}</span>
			</header>
			{(parseErrors.length > 0 || warnings.length > 0) && (
				<details className="warn">
					<summary>{parseErrors.length + warnings.length} warning(s) about the trace</summary>
					<ul>
						{parseErrors.length > 0 && <li>Unparseable line(s): {parseErrors.slice(0, 8).join(', ')}</li>}
						{warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
					</ul>
				</details>
			)}

			{!snap ? <p className="empty big">Load a trace to begin.</p> : (
				<>
					<div className="controls">
						<button onClick={() => setPos(0)} title="Start">⏮</button>
						<button onClick={() => setPos((p) => Math.max(p - 1, 0))} title="Back (←)">◀</button>
						<button className="primary" onClick={() => setPlaying((p) => !p)} title="Play/pause (space)">{playing ? '⏸' : '▶'}</button>
						<button onClick={() => setPos((p) => Math.min(p + 1, last))} title="Forward (→)">▶▶</button>
						<button onClick={() => setPos(last)} title="End">⏭</button>
						<input type="range" min="0" max={last} value={pos} onChange={(e) => setPos(+e.target.value)} />
						<span className="count">{pos + 1} / {steps.length}</span>
						<select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
							<option value={1400}>slow</option><option value={700}>normal</option><option value={250}>fast</option><option value={80}>turbo</option>
						</select>
					</div>

					<div className="now">
						<div className="now-main">
							<span className={'badge ' + snap.kind}>{snap.title}</span>
							<span className="desc">{snap.description}</span>
						</div>
						<div className="chips">
							{chips.map((c, i) => <span key={i} className={'chip ' + c.k}>{c.t}</span>)}
						</div>
					</div>

					<main>
						<div className="col">
							<CodePanel snap={snap} source={source} />
							<FramesPanel snap={snap} />
						</div>
						<StackPanel snap={snap} hovered={hovered} setHovered={setHovered} />
						<div className="col">
							<HeapPanel snap={snap} hovered={hovered} setHovered={setHovered} />
							<GlobalsPanel snap={snap} hovered={hovered} setHovered={setHovered} />
							<ConsolePanel snap={snap} />
						</div>
					</main>
					<LogPanel steps={steps} pos={pos} setPos={setPos} />
				</>
			)}
		</div>
	);
}
