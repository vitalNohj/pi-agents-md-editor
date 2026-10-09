/**
 * pi-agents-toggle
 *
 * Toggle, edit, or empty AGENTS.md / CLAUDE.md context files from inside Pi.
 * Changes are a session overlay: files on disk stay untouched unless you
 * explicitly write one with `E`. Changes apply "forward": from your next
 * message, Pi appends a prompt-section update so the model sees the new
 * project_context from then on.
 *
 *   /agents          open the tree window
 *   /agents off      send no context files
 *   /agents on       turn context files back on (keeps line toggles)
 *   /agents reset    drop every toggle and edit
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Input, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------- state

interface FileState {
	off?: boolean;
	disabled: string[];
	edits: Record<string, string>;
	/** File was rewritten on disk through this extension; re-read it instead of Pi's startup copy. */
	diskDirty?: boolean;
}

interface State {
	allOff: boolean;
	files: Record<string, FileState>;
}

const ENTRY = "agents-toggle";
const emptyState = (): State => ({ allOff: false, files: {} });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const fileState = (s: State, path: string): FileState => (s.files[path] ??= { disabled: [], edits: {} });

function isDirty(s: State): boolean {
	return (
		s.allOff ||
		Object.values(s.files).some((f) => f.off || f.diskDirty || f.disabled.length > 0 || Object.keys(f.edits).length > 0)
	);
}

// ---------------------------------------------------------------- settings (vim mode)

const settingsPath = () => join(getAgentDir(), "agents-toggle.json");

function loadVim(): boolean {
	try {
		return JSON.parse(readFileSync(settingsPath(), "utf8")).vim === true;
	} catch {
		return false;
	}
}

function saveVim(vim: boolean): void {
	try {
		writeFileSync(settingsPath(), `${JSON.stringify({ vim }, null, 2)}\n`);
	} catch {
		// non-fatal: preference just won't persist
	}
}

// ---------------------------------------------------------------- markdown -> tree

interface Node {
	key: string;
	start: number;
	end: number;
	indent: string;
	text: string;
	heading: boolean;
	parent?: Node;
	children: Node[];
}

const LIST = /^(\s*)([-*+]|\d+[.)]|[a-zA-Z][.)])\s+/;
const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(```|~~~)/;

function parse(content: string): { lines: string[]; nodes: Node[]; roots: Node[] } {
	const lines = content.split("\n");
	const nodes: Node[] = [];
	const roots: Node[] = [];
	const stack: { rank: number; node: Node }[] = [];
	const seen = new Map<string, number>();
	let prevBlank = true;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			prevBlank = true;
			continue;
		}
		const indent = line.match(/^\s*/)?.[0] ?? "";
		const h = line.match(HEADING);
		const isList = LIST.test(line);
		const last = nodes[nodes.length - 1];

		// Wrapped paragraph / list continuation: fold into the previous node.
		if (!h && !isList && !FENCE.test(line) && !prevBlank && last && !last.heading) {
			last.end = i;
			continue;
		}
		prevBlank = false;

		let end = i;
		if (FENCE.test(line)) {
			while (end + 1 < lines.length && !FENCE.test(lines[end + 1])) end++;
			if (end + 1 < lines.length) end++;
		}

		const base = line.trim();
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		const node: Node = { key: n > 1 ? `${base}#${n}` : base, start: i, end, indent, text: base, heading: !!h, children: [] };
		const rank = h ? h[1].length : 10 + indent.replace(/\t/g, "    ").length;

		while (stack.length && stack[stack.length - 1].rank >= rank) stack.pop();
		const parent = stack[stack.length - 1]?.node;
		if (parent) {
			node.parent = parent;
			parent.children.push(node);
		} else roots.push(node);
		stack.push({ rank, node });
		nodes.push(node);
		i = end;
	}
	return { lines, nodes, roots };
}

function nodeOff(node: Node, fs: FileState | undefined): boolean {
	for (let n: Node | undefined = node; n; n = n.parent) if (fs?.disabled.includes(n.key)) return true;
	return false;
}

/** Content the model will see for one file under the overlay. */
function applyFile(content: string, fs: FileState | undefined): string {
	if (!fs) return content;
	if (fs.off) return "";
	const { lines, nodes } = parse(content);
	const drop = new Set<number>();
	const replace = new Map<number, string>();
	for (const node of nodes) {
		if (nodeOff(node, fs)) {
			for (let i = node.start; i <= node.end; i++) drop.add(i);
		} else if (fs.edits[node.key] !== undefined) {
			replace.set(node.start, node.indent + fs.edits[node.key]);
			for (let i = node.start + 1; i <= node.end; i++) drop.add(i);
		}
	}
	const out: string[] = [];
	lines.forEach((line, i) => {
		if (drop.has(i)) return;
		out.push(replace.get(i) ?? line);
	});
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function applyAll(files: { path: string; content: string }[], s: State): { path: string; content: string }[] {
	if (s.allOff) return [];
	return files
		.map((f) => {
			const fs = s.files[f.path];
			const base = fs?.diskDirty && existsSync(f.path) ? readFileSync(f.path, "utf8") : f.content;
			return { path: f.path, content: applyFile(base, fs) };
		})
		.filter((f) => f.content.trim().length > 0);
}

// ---------------------------------------------------------------- tree UI

interface Row {
	file: string;
	node?: Node;
	depth: number;
}

interface FileView {
	path: string;
	content: string;
	roots: Node[];
	nodes: Node[];
}

type Result = { kind: "apply"; state: State } | { kind: "cancel" } | { kind: "editFile"; state: State; path: string };

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

function counts(files: FileView[], s: State): { on: number; total: number } {
	let on = 0;
	let total = 0;
	for (const f of files) {
		const fs = s.files[f.path];
		for (const n of f.nodes) {
			total++;
			if (!s.allOff && !fs?.off && !nodeOff(n, fs)) on++;
		}
	}
	return { on, total };
}

function statusText(files: FileView[], s: State): string {
	if (s.allOff) return "AGENTS off";
	if (!isDirty(s)) return "AGENTS on";
	const { on, total } = counts(files, s);
	const edited = Object.values(s.files).some((f) => Object.keys(f.edits).length > 0 || f.diskDirty);
	return `AGENTS ${on}/${total}${edited ? " ✎" : ""}`;
}

class TreeView {
	private state: State;
	private undo: State[] = [];
	private cursor = 0;
	private scroll = 0;
	private folded = new Set<string>();
	private pending = "";
	private editing?: { row: Row; input: Input };
	private cmdline?: Input;
	private message = "";

	constructor(
		private tui: TUI,
		private theme: Theme,
		private files: FileView[],
		state: State,
		private cwd: string,
		private agentDir: string,
		private vim: boolean,
		private done: (r: Result) => void,
	) {
		this.state = clone(state);
	}

	private foldId(r: Row) {
		return r.node ? `${r.file}\u0000${r.node.key}` : r.file;
	}

	private rows(): Row[] {
		const rows: Row[] = [];
		const walk = (file: string, nodes: Node[], depth: number) => {
			for (const node of nodes) {
				const row = { file, node, depth };
				rows.push(row);
				if (node.children.length && !this.folded.has(this.foldId(row))) walk(file, node.children, depth + 1);
			}
		};
		for (const f of this.files) {
			rows.push({ file: f.path, depth: 0 });
			if (!this.folded.has(f.path)) walk(f.path, f.roots, 1);
		}
		return rows;
	}

	private mutate(fn: (s: State) => void) {
		this.undo.push(clone(this.state));
		fn(this.state);
	}

	private toggle(r: Row) {
		this.mutate((s) => {
			const fs = fileState(s, r.file);
			if (!r.node) fs.off = !fs.off;
			else if (fs.disabled.includes(r.node.key)) fs.disabled = fs.disabled.filter((k) => k !== r.node?.key);
			else fs.disabled.push(r.node.key);
		});
	}

	private startEdit(r: Row) {
		if (!r.node) {
			this.done({ kind: "editFile", state: this.state, path: r.file });
			return;
		}
		const f = this.files.find((x) => x.path === r.file);
		const input = new Input();
		const lines = f?.content.split("\n").slice(r.node.start, r.node.end + 1) ?? [];
		input.setValue(this.state.files[r.file]?.edits[r.node.key] ?? lines.map((l) => l.trim()).join(" "));
		input.handleInput("\x05"); // ctrl+e: put the cursor at the end of the line
		input.focused = true;
		const node = r.node;
		input.onSubmit = (value) => {
			const original = lines.map((l) => l.trim()).join(" ");
			this.mutate((s) => {
				const fs = fileState(s, r.file);
				if (value.trim() === original || !value.trim()) delete fs.edits[node.key];
				else fs.edits[node.key] = value.trim();
			});
			this.editing = undefined;
			this.refresh();
		};
		input.onEscape = () => {
			this.editing = undefined;
			this.refresh();
		};
		this.editing = { row: r, input };
	}

	private runCommand(cmd: string) {
		const c = cmd.trim();
		if (c === "w" || c === "wq" || c === "x") this.done({ kind: "apply", state: this.state });
		else if (c === "q" || c === "q!") this.done({ kind: "cancel" });
		else if (c === "off") this.mutate((s) => void (s.allOff = true));
		else if (c === "on") this.mutate((s) => void (s.allOff = false));
		else if (c === "e") {
			const r = this.rows()[this.cursor];
			if (r) this.done({ kind: "editFile", state: this.state, path: r.file });
		} else this.message = `Unknown command :${c}`;
	}

	private refresh() {
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		this.message = "";
		if (this.editing) {
			this.editing.input.handleInput(data);
			return this.refresh();
		}
		if (this.cmdline) {
			if (matchesKey(data, "escape")) this.cmdline = undefined;
			else this.cmdline.handleInput(data);
			return this.refresh();
		}

		const rows = this.rows();
		const row = rows[this.cursor];
		const ch = decodeKittyPrintable(data) ?? (data.length === 1 ? data : "");
		const page = Math.max(1, Math.floor(this.viewHeight() / 2));
		const move = (n: number) => (this.cursor = Math.max(0, Math.min(rows.length - 1, this.cursor + n)));
		const chord = this.pending + ch;
		this.pending = "";

		const fold = (close: boolean) => {
			if (!row) return;
			const hasKids = row.node ? row.node.children.length > 0 : true;
			const id = this.foldId(row);
			if (close) {
				if (hasKids && !this.folded.has(id)) this.folded.add(id);
				else {
					// jump to parent row
					for (let i = this.cursor - 1; i >= 0; i--) if (rows[i].depth < row.depth) return void (this.cursor = i);
				}
			} else if (hasKids) this.folded.delete(id);
		};

		// keys shared by both modes
		if (matchesKey(data, "up")) move(-1);
		else if (matchesKey(data, "down")) move(1);
		else if (matchesKey(data, "pageUp")) move(-page * 2);
		else if (matchesKey(data, "pageDown")) move(page * 2);
		else if (matchesKey(data, "left")) fold(true);
		else if (matchesKey(data, "right")) fold(false);
		else if (matchesKey(data, "space")) row && this.toggle(row);
		else if (matchesKey(data, "enter") || matchesKey(data, "escape")) this.done({ kind: "apply", state: this.state });
		else if (ch === "v") {
			this.vim = !this.vim;
			saveVim(this.vim);
		} else if (this.vim) {
			if (ch === "j") move(1);
			else if (ch === "k") move(-1);
			else if (ch === "h") fold(true);
			else if (ch === "l") fold(false);
			else if (chord === "gg") this.cursor = 0;
			else if (ch === "G") this.cursor = rows.length - 1;
			else if (matchesKey(data, "ctrl+d")) move(page);
			else if (matchesKey(data, "ctrl+u")) move(-page);
			else if (chord === "za" && row) fold(!this.folded.has(this.foldId(row)) ? true : false);
			else if (ch === "x" && row) this.toggle(row);
			else if (chord === "dd" && row) this.toggle(row);
			else if ((ch === "i" || chord === "cc") && row) this.startEdit(row);
			else if (ch === "u") this.popUndo();
			else if (chord === "ZZ") this.done({ kind: "apply", state: this.state });
			else if (chord === "ZQ") this.done({ kind: "cancel" });
			else if (ch === ":") {
				this.cmdline = new Input({ prompt: ":" });
				this.cmdline.focused = true;
				this.cmdline.onSubmit = (v) => {
					this.cmdline = undefined;
					this.runCommand(v);
					this.refresh();
				};
			} else if ("gzdcZ".includes(ch) && ch) this.pending = ch;
		} else {
			if (ch === "e" && row) this.startEdit(row);
			else if (ch === "E" && row) this.done({ kind: "editFile", state: this.state, path: row.file });
			else if (ch === "u") this.popUndo();
			else if (ch === "0") this.mutate((s) => void (s.allOff = true));
			else if (ch === "1") this.mutate((s) => void (s.allOff = false));
			else if (ch === "r") this.mutate((s) => Object.assign(s, emptyState()));
			else if (ch === "q") this.done({ kind: "cancel" });
		}
		this.refresh();
	}

	private popUndo() {
		const prev = this.undo.pop();
		if (prev) this.state = prev;
		else this.message = "Nothing to undo";
	}

	private viewHeight(): number {
		return Math.max(6, this.tui.terminal.rows - 12);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.max(20, width);
		const rows = this.rows();
		this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
		const height = this.viewHeight();
		if (this.cursor < this.scroll) this.scroll = this.cursor;
		if (this.cursor >= this.scroll + height) this.scroll = this.cursor - height + 1;

		const { on, total } = counts(this.files, this.state);
		const n = this.files.length;
		const summary = this.state.allOff ? "ALL OFF" : `${n} file${n === 1 ? "" : "s"} · ${on}/${total} lines`;
		const right = `${summary} · session/forward${this.vim ? " · vim" : ""} `;
		const title = " AGENTS context";
		const gap = " ".repeat(Math.max(1, w - visibleWidth(title) - visibleWidth(right)));
		const out: string[] = [
			truncateToWidth(`${t.bold(title)}${gap}${t.fg(this.state.allOff ? "error" : "muted", right)}`, w),
			t.fg("border", "─".repeat(w)),
		];

		if (!rows.length) out.push(t.fg("muted", "  No AGENTS.md or CLAUDE.md files are loaded for this directory."));

		for (const r of rows.slice(this.scroll, this.scroll + height)) {
			const selected = rows.indexOf(r) === this.cursor;
			const fs = this.state.files[r.file];
			const pad = "  ".repeat(r.depth);
			let line: string;
			if (!r.node) {
				const f = this.files.find((x) => x.path === r.file);
				const isGlobal = dirname(r.file) === this.agentDir;
				const tag = isGlobal ? "Global  " : dirname(r.file) === this.cwd ? "cwd     " : "        ";
				const arrow = this.folded.has(r.file) ? "▸" : "▾";
				const mark = this.state.allOff || fs?.off ? t.fg("error", "○") : t.fg("success", "●");
				const extra = [fs?.off ? "(file off)" : "", fs?.diskDirty ? "(written)" : "", `${f?.nodes.length ?? 0} lines`]
					.filter(Boolean)
					.join(" ");
				line = `${arrow} ${mark} ${t.fg("accent", tag)}${t.bold(tilde(r.file))}  ${t.fg("dim", extra)}`;
			} else {
				const n = r.node;
				const selfOff = fs?.disabled.includes(n.key);
				const why = this.state.allOff ? "all off" : fs?.off ? "file off" : selfOff ? "off" : nodeOff(n, fs) ? "parent off" : "";
				const off = why !== "";
				const edited = fs?.edits[n.key];
				const arrow = n.children.length ? (this.folded.has(this.foldId(r)) ? "▸" : "▾") : " ";
				const mark = off ? t.fg("error", "○") : edited !== undefined ? t.fg("warning", "✎") : t.fg("success", "●");
				if (this.editing?.row === r) {
					const field = this.editing.input.render(Math.max(10, w - pad.length - 4))[0] ?? "";
					out.push(`${pad}${arrow} ${t.fg("warning", "✎")} ${field}`);
					continue;
				}
				let text = edited ?? n.text;
				if (n.end > n.start && edited === undefined) text += t.fg("dim", ` (+${n.end - n.start} lines)`);
				text = off ? t.fg("dim", text) : n.heading ? t.fg("mdHeading", text) : text;
				const tags = [why, edited !== undefined ? "edited" : ""].filter(Boolean).join(", ");
				const note = tags ? t.fg("dim", `  (${tags})`) : "";
				line = `${pad}${arrow} ${mark} ${text}${note}`;
			}
			line = truncateToWidth(line, w);
			out.push(selected ? t.bg("selectedBg", truncateToWidth(line, w, "…", true)) : line);
		}

		out.push(t.fg("border", "─".repeat(w)));
		if (this.cmdline) out.push(this.cmdline.render(w)[0] ?? ":");
		else if (this.editing) out.push(t.fg("dim", " enter save · esc cancel · empty or original text clears the edit"));
		else {
			const help = this.vim
				? " j/k move · h/l fold · gg/G · space/x/dd toggle · i/cc edit · :e edit file · u undo · :off/:on · :w/ZZ apply · :q! cancel · v vim off"
				: " ↑↓ move · ←→ fold · space toggle · e edit line · E edit file · u undo · 0 all off · 1 all on · r reset · enter/esc apply · q cancel · v vim";
			for (const l of wrap(help, w)) out.push(t.fg("dim", l));
		}
		if (this.message) out.push(t.fg("warning", ` ${this.message}`));
		return out;
	}
}

function wrap(text: string, width: number): string[] {
	const parts = text.split(" · ");
	const lines: string[] = [];
	let cur = "";
	for (const p of parts) {
		const next = cur ? `${cur} · ${p}` : p;
		if (next.length > width && cur) {
			lines.push(cur);
			cur = ` ${p.trim()}`;
		} else cur = next;
	}
	if (cur) lines.push(cur);
	return lines;
}

// ---------------------------------------------------------------- extension

export default function agentsToggle(pi: ExtensionAPI) {
	let state = emptyState();

	const loadFiles = (ctx: ExtensionContext): FileView[] => {
		const agentDir = resolve(getAgentDir());
		return loadProjectContextFiles({ cwd: ctx.cwd, agentDir }).map((f) => {
			const content = existsSync(f.path) ? readFileSync(f.path, "utf8") : f.content;
			const { nodes, roots } = parse(content);
			return { path: f.path, content, nodes, roots };
		});
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const text = statusText(loadFiles(ctx), state);
		const color = state.allOff ? "warning" : isDirty(state) ? "accent" : "dim";
		ctx.ui.setStatus(ENTRY, ctx.ui.theme.fg(color, text));
	};

	const restore = (ctx: ExtensionContext) => {
		state = emptyState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY && entry.data) state = clone(entry.data as State);
		}
		updateStatus(ctx);
	};

	const commit = (ctx: ExtensionContext, next: State, note?: string) => {
		const changed = JSON.stringify(next) !== JSON.stringify(state);
		state = next;
		if (changed) {
			pi.appendEntry<State>(ENTRY, state);
			ctx.ui.notify(note ?? "AGENTS context updated. It applies from your next message.", "info");
		}
		updateStatus(ctx);
	};

	pi.on("session_start", (_e, ctx) => restore(ctx));
	pi.on("session_tree", (_e, ctx) => restore(ctx));

	pi.on("before_agent_start", (event) => {
		if (!isDirty(state)) return;
		event.systemPromptOptions.contextFiles = applyAll(event.systemPromptOptions.contextFiles ?? [], state);
	});

	const openTree = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/agents needs the interactive TUI. Use /agents on|off|reset here.", "warning");
			return;
		}
		let working = clone(state);
		for (;;) {
			const files = loadFiles(ctx);
			const agentDir = resolve(getAgentDir());
			const result = await ctx.ui.custom<Result>(
				(tui, theme, _kb, done) => new TreeView(tui, theme, files, working, resolve(ctx.cwd), agentDir, loadVim(), done),
			);
			if (result.kind === "cancel") return;
			if (result.kind === "apply") return commit(ctx, result.state);

			// Edit a whole file on disk with Pi's editor, then come back to the tree.
			working = result.state;
			const original = readFileSync(result.path, "utf8");
			const edited = await ctx.ui.editor(`Edit ${tilde(result.path)} (saves to disk)`, original);
			if (edited !== undefined && edited !== original) {
				const ok = await ctx.ui.confirm("Write to disk?", `Overwrite ${tilde(result.path)}? This affects future sessions too.`);
				if (ok) {
					writeFileSync(result.path, edited);
					fileState(working, result.path).diskDirty = true;
				}
			}
		}
	};

	pi.registerCommand("agents", {
		description: "Toggle or edit AGENTS.md context: /agents [on|off|reset]",
		getArgumentCompletions: (prefix) =>
			["on", "off", "reset"]
				.filter((v) => v.startsWith(prefix.trim()))
				.map((v) => ({ value: v, label: v, description: `AGENTS context ${v}` })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off") return commit(ctx, { ...clone(state), allOff: true }, "AGENTS context off from your next message.");
			if (arg === "on") return commit(ctx, { ...clone(state), allOff: false }, "AGENTS context on from your next message.");
			if (arg === "reset") {
				// keep diskDirty so a file written through /agents is still read fresh
				const next = emptyState();
				for (const [p, f] of Object.entries(state.files)) if (f.diskDirty) next.files[p] = { disabled: [], edits: {}, diskDirty: true };
				return commit(ctx, next, "AGENTS context reset to the files on disk from your next message.");
			}
			if (arg) return ctx.ui.notify(`Unknown argument "${arg}". Use /agents, /agents on, /agents off, /agents reset.`, "warning");
			await openTree(ctx);
		},
	});
}
