/**
 * pi-agents-md-editor
 *
 * Toggle, edit, or empty AGENTS.md / CLAUDE.md context files from inside Pi.
 * Toggles and edits are a global overlay saved in <agent-dir>/agents-md-editor.json;
 * files on disk stay untouched unless you explicitly write one with `E`.
 *
 * Every session keeps the context it started with. When you apply a change you
 * choose what happens to the current session:
 *   save     (default) nothing; new sessions get the change
 *   next     on your next prompt, the AGENTS block is swapped in place, as if the
 *            session always had it (invalidates the prompt cache once)
 *   restart  fork the session with the AGENTS block replaced in its stored history
 *            and switch to the fork now
 *
 *   /agents                       open the tree window
 *   /agents off|on|reset [--next|--restart]
 */

import { randomUUID } from "node:crypto";
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
}

interface State {
	allOff: boolean;
	files: Record<string, FileState>;
}

type ContextFile = { path: string; content: string };
type Mode = "save" | "next" | "restart";

const ENTRY = "agents-md-editor";
const SECTION = "project_context";
const emptyState = (): State => ({ allOff: false, files: {} });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const fileState = (s: State, path: string): FileState => (s.files[path] ??= { disabled: [], edits: {} });
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function isDirty(s: State): boolean {
	return s.allOff || Object.values(s.files).some((f) => f.off || f.disabled.length > 0 || Object.keys(f.edits).length > 0);
}

/** Drop empty per-file entries so the saved config stays readable. */
function normalize(s: State): State {
	const out: State = { allOff: s.allOff, files: {} };
	for (const [p, f] of Object.entries(s.files)) {
		if (f.off || f.disabled.length || Object.keys(f.edits).length) out.files[p] = f;
	}
	return out;
}

// ---------------------------------------------------------------- global config

const configPath = () => join(getAgentDir(), "agents-md-editor.json");

function readConfig(): { vim: boolean; state: State } {
	try {
		const raw = JSON.parse(readFileSync(configPath(), "utf8"));
		return { vim: raw.vim === true, state: { allOff: raw.allOff === true, files: raw.files ?? {} } };
	} catch {
		return { vim: false, state: emptyState() };
	}
}

function writeConfig(patch: { vim?: boolean; state?: State }): void {
	const cur = readConfig();
	const vim = patch.vim ?? cur.vim;
	const state = normalize(patch.state ?? cur.state);
	writeFileSync(configPath(), `${JSON.stringify({ vim, ...state }, null, 2)}\n`);
}

const loadVim = () => readConfig().vim;
const saveVim = (vim: boolean) => {
	try {
		writeConfig({ vim });
	} catch {
		// non-fatal: preference just won't persist
	}
};

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

function applyAll(files: ContextFile[], s: State): ContextFile[] {
	if (s.allOff) return [];
	return files
		.map((f) => ({ path: f.path, content: applyFile(f.content, s.files[f.path]) }))
		.filter((f) => f.content.trim().length > 0);
}

// ---------------------------------------------------------------- the project_context prompt section

/** Same rendering as Pi's system-prompt builder, including the section tags. */
function renderSection(files: ContextFile[]): string | undefined {
	if (!files.length) return undefined;
	const body = [
		"Project-specific instructions and guidelines:",
		...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
	].join("\n\n");
	return `<${SECTION}>\n${body}\n</${SECTION}>`;
}

function parseSection(section: string | undefined): ContextFile[] {
	if (!section) return [];
	const files: ContextFile[] = [];
	const re = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>(?=\n\n<project_instructions path=|\n<\/project_context>$)/g;
	for (const m of section.matchAll(re)) files.push({ path: m[1], content: m[2] });
	return files;
}

interface SystemLike {
	role: "system";
	content: unknown;
	sections?: Record<string, string | null>;
	toolsAdded?: unknown[];
	toolsRemoved?: unknown[];
}
const isSystem = (m: unknown): m is SystemLike => (m as { role?: string } | undefined)?.role === "system";

/**
 * The project_context section the transcript currently carries: the leading message's
 * value with later section updates applied. `undefined` means the transcript has no
 * system prompt yet (a session that has not been prompted).
 */
function transcriptSection(messages: unknown[]): { has: boolean; value: string | undefined } {
	let has = false;
	let value: string | undefined;
	for (const m of messages) {
		if (!isSystem(m)) continue;
		has = true;
		if (m.sections && SECTION in m.sections) value = m.sections[SECTION] ?? undefined;
	}
	return { has, value };
}

/** Put project_context where Pi would: before skills/cwd/custom sections. */
function withSection(sections: Record<string, string | null>, value: string | undefined): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	let placed = value === undefined;
	for (const [k, v] of Object.entries(sections)) {
		if (k === SECTION) continue;
		if (!placed && (k === "skills" || k === "cwd")) {
			out[SECTION] = value as string;
			placed = true;
		}
		out[k] = v;
	}
	if (!placed) out[SECTION] = value as string;
	return out;
}

/**
 * Rewrite a transcript so the latest project_context lives in the leading prompt and no
 * later message mentions it: the model sees one prompt, as if it always had this context.
 */
function collapse<T>(messages: T[]): T[] {
	const { has, value } = transcriptSection(messages);
	if (!has) return messages;
	let leading = true;
	const out: T[] = [];
	for (const m of messages) {
		if (!isSystem(m)) {
			out.push(m);
			continue;
		}
		if (leading) {
			leading = false;
			out.push({ ...m, sections: withSection(m.sections ?? {}, value) });
			continue;
		}
		if (!m.sections || !(SECTION in m.sections)) {
			out.push(m);
			continue;
		}
		const { [SECTION]: _drop, ...rest } = m.sections;
		const empty =
			!Object.keys(rest).length && !m.toolsAdded?.length && !m.toolsRemoved?.length && !String(m.content ?? "").length;
		if (!empty) out.push({ ...m, sections: rest });
	}
	return out;
}

const sameFiles = (a: ContextFile[], b: ContextFile[]) => JSON.stringify(a) === JSON.stringify(b);

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

function stateLabel(files: FileView[], s: State): string {
	if (s.allOff) return "off";
	if (!isDirty(s)) return "on";
	const { on, total } = counts(files, s);
	const edited = Object.values(s.files).some((f) => Object.keys(f.edits).length > 0);
	return `${on}/${total}${edited ? " ✎" : ""}`;
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
		const right = `${summary} · global${this.vim ? " · vim" : ""} `;
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
				const extra = [fs?.off ? "(file off)" : "", `${f?.nodes.length ?? 0} lines`]
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

type Marker = { kind: "swap" } | { kind: "swapped" };

const MODE_LABELS: Record<Mode, string> = {
	save: "Save only            new sessions get it; this session is untouched",
	next: "Swap on next prompt  this session too, as if it always had it (invalidates cache)",
	restart: "Restart now          fork this session with its history rewritten (invalidates cache)",
};

const sessionSystem = (e: { type: string; message?: unknown; systemMessage?: unknown }): SystemLike | undefined =>
	e.type === "message" && isSystem(e.message)
		? e.message
		: e.type === "compaction" && isSystem(e.systemMessage)
			? e.systemMessage
			: undefined;

/**
 * Copy a session file with project_context replaced in its history: the leading prompt of
 * every branch (and every compaction snapshot) carries `value`, and later section updates
 * for project_context are removed. Returns the new file path.
 */
function forkWithContext(sourcePath: string, value: string | undefined): string {
	const [headerLine, ...rest] = readFileSync(sourcePath, "utf8").split("\n").filter(Boolean);
	const header = JSON.parse(headerLine);
	// biome-ignore lint/suspicious/noExplicitAny: raw session JSONL entries
	const entries: any[] = rest.map((l) => JSON.parse(l));
	const byId = new Map(entries.map((e) => [e.id, e]));
	const referenced = new Set(entries.flatMap((e) => [e.firstKeptEntryId, e.targetId, e.fromId].filter(Boolean)));
	const hasSystemAncestor = (e: { parentId?: string | null }) => {
		for (let p = e.parentId ? byId.get(e.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
			if (sessionSystem(p)) return true;
		}
		return false;
	};

	const dropped = new Map<string, string | null>();
	const leading = new Set(entries.filter((e) => sessionSystem(e) && (e.type === "compaction" || !hasSystemAncestor(e))));
	const out = [];
	for (const e of entries) {
		const sys = sessionSystem(e);
		if (sys && leading.has(e)) sys.sections = withSection(sys.sections ?? {}, value);
		else if (sys?.sections && SECTION in sys.sections) {
			delete sys.sections[SECTION];
			const empty =
				!Object.keys(sys.sections).length && !sys.toolsAdded?.length && !sys.toolsRemoved?.length && !String(sys.content ?? "");
			if (empty && !referenced.has(e.id)) {
				dropped.set(e.id, e.parentId ?? null);
				continue;
			}
		}
		out.push(e);
	}
	const parentOf = (id: string | null) => {
		while (id && dropped.has(id)) id = dropped.get(id) ?? null;
		return id;
	};
	for (const e of out) if ("parentId" in e) e.parentId = parentOf(e.parentId);

	const id = randomUUID();
	const timestamp = new Date().toISOString();
	const path = join(dirname(sourcePath), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const newHeader = { ...header, id, timestamp, parentSession: sourcePath };
	writeFileSync(path, `${[newHeader, ...out].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return path;
}

export default function agentsToggle(pi: ExtensionAPI) {
	/** Context files as on disk now, or [] when Pi was started without context files. */
	const diskFiles = (ctx: ExtensionContext): ContextFile[] => {
		if (piDisabledContext) return [];
		return loadProjectContextFiles({ cwd: ctx.cwd, agentDir: resolve(getAgentDir()) }).map((f) => ({
			path: f.path,
			content: existsSync(f.path) ? stripBom(readFileSync(f.path, "utf8")) : f.content,
		}));
	};
	let piDisabledContext = false;

	const fileViews = (ctx: ExtensionContext): FileView[] =>
		diskFiles(ctx).map((f) => {
			const { nodes, roots } = parse(f.content);
			return { ...f, nodes, roots };
		});

	/** What new sessions get: the files on disk with the global overlay applied. */
	const fresh = (ctx: ExtensionContext) => applyAll(diskFiles(ctx), readConfig().state);

	const markers = (ctx: ExtensionContext) => {
		let swap = -1;
		let swapped = -1;
		ctx.sessionManager.getBranch().forEach((e, i) => {
			if (e.type !== "custom" || e.customType !== ENTRY) return;
			const kind = (e.data as Marker | undefined)?.kind;
			if (kind === "swap") swap = i;
			if (kind === "swapped") swapped = i;
		});
		return { pending: swap > swapped, collapsed: swapped >= 0 };
	};

	/** The context this session sends: whatever its transcript already carries, unless a swap is pending. */
	const sessionFiles = (ctx: ExtensionContext): { files: ContextFile[]; pinned: boolean } => {
		if (markers(ctx).pending) return { files: fresh(ctx), pinned: false };
		const { has, value } = transcriptSection(ctx.sessionManager.buildSessionProjection().messages);
		if (!has) return { files: fresh(ctx), pinned: false };
		const files = parseSection(value);
		// Only pin what round-trips exactly; anything else falls back to the fresh context.
		if (renderSection(files) !== value) return { files: fresh(ctx), pinned: false };
		return { files, pinned: true };
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const s = readConfig().state;
		const label = stateLabel(fileViews(ctx), s);
		const session = sessionFiles(ctx);
		const differs = !sameFiles(session.files, fresh(ctx));
		const suffix = markers(ctx).pending ? " (next prompt)" : differs ? " (next session)" : "";
		const color = differs || markers(ctx).pending ? "warning" : s.allOff ? "warning" : isDirty(s) ? "accent" : "dim";
		ctx.ui.setStatus(ENTRY, ctx.ui.theme.fg(color, `AGENTS ${label}${suffix}`));
	};

	const apply = async (ctx: ExtensionCommandContext, next: State, mode: Mode) => {
		const before = readConfig().state;
		const globalChanged = JSON.stringify(normalize(next)) !== JSON.stringify(normalize(before));
		if (globalChanged) writeConfig({ state: next });
		const saved = globalChanged ? "Saved for new sessions." : "Global settings unchanged.";

		if (mode === "save") ctx.ui.notify(`${saved} This session is untouched.`, "info");
		else if (mode === "next") {
			pi.appendEntry<Marker>(ENTRY, { kind: "swap" });
			ctx.ui.notify(`${saved} This session swaps on your next prompt (the prompt cache is rebuilt once).`, "info");
		} else {
			const file = ctx.sessionManager.getSessionFile();
			const { has } = transcriptSection(ctx.sessionManager.buildSessionProjection().messages);
			if (!file || !existsSync(file) || !has) {
				// Nothing recorded yet: the next prompt already starts from the new context.
				if (has) pi.appendEntry<Marker>(ENTRY, { kind: "swap" });
				ctx.ui.notify(`${saved} This session has no saved prompt yet, so it uses the new context from the next prompt.`, "info");
			} else {
				await ctx.waitForIdle();
				const path = forkWithContext(file, renderSection(fresh(ctx)));
				const result = await ctx.switchSession(path, {
					withSession: async (c) => c.ui.notify(`${saved} Restarted in a copy of the session with the new context in its history.`, "info"),
				});
				if (result.cancelled) ctx.ui.notify(`${saved} Restart cancelled; the copy is at ${tilde(path)}.`, "warning");
				return;
			}
		}
		updateStatus(ctx);
	};

	const pickMode = async (ctx: ExtensionCommandContext): Promise<Mode | undefined> => {
		const choice = await ctx.ui.select("Apply AGENTS changes", Object.values(MODE_LABELS));
		return (Object.keys(MODE_LABELS) as Mode[]).find((m) => MODE_LABELS[m] === choice);
	};

	pi.on("session_start", (_e, ctx) => {
		piDisabledContext = false;
		updateStatus(ctx);
	});
	pi.on("session_tree", (_e, ctx) => updateStatus(ctx));
	pi.on("agent_end", (_e, ctx) => updateStatus(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		// Respect `pi --no-context-files`: Pi loaded nothing although files exist.
		const base = event.systemPromptOptions.contextFiles ?? [];
		piDisabledContext =
			base.length === 0 && loadProjectContextFiles({ cwd: ctx.cwd, agentDir: resolve(getAgentDir()) }).length > 0;
		if (piDisabledContext) return;
		const { pending } = markers(ctx);
		event.systemPromptOptions.contextFiles = sessionFiles(ctx).files;
		if (pending) pi.appendEntry<Marker>(ENTRY, { kind: "swapped" });
	});

	// After a swap, show the model one prompt that always had the new context.
	pi.on("context_with_system", (event, ctx) => {
		if (!markers(ctx).collapsed) return;
		return { messages: collapse(event.messages) };
	});

	const openTree = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/agents needs the interactive TUI. Use /agents on|off|reset [--next|--restart] here.", "warning");
			return;
		}
		let working = readConfig().state;
		for (;;) {
			const files = fileViews(ctx);
			const agentDir = resolve(getAgentDir());
			const result = await ctx.ui.custom<Result>(
				(tui, theme, _kb, done) => new TreeView(tui, theme, files, working, resolve(ctx.cwd), agentDir, loadVim(), done),
			);
			if (result.kind === "cancel") return;
			working = result.state;

			if (result.kind === "apply") {
				const unchanged = JSON.stringify(normalize(working)) === JSON.stringify(normalize(readConfig().state));
				if (unchanged && sameFiles(sessionFiles(ctx).files, fresh(ctx))) {
					ctx.ui.notify("No changes.", "info");
					return;
				}
				const mode = await pickMode(ctx);
				if (!mode) continue; // back to the tree with edits intact
				return apply(ctx, working, mode);
			}

			// Edit a whole file on disk with Pi's editor, then come back to the tree.
			const original = readFileSync(result.path, "utf8");
			const edited = await ctx.ui.editor(`Edit ${tilde(result.path)} (saves to disk)`, original);
			if (edited !== undefined && edited !== original) {
				const ok = await ctx.ui.confirm(
					"Write to disk?",
					`Overwrite ${tilde(result.path)}? New sessions use it; existing sessions keep what they started with.`,
				);
				if (ok) writeFileSync(result.path, edited);
			}
		}
	};

	const ARGS = ["on", "off", "reset"];
	pi.registerCommand("agents", {
		description: "Toggle or edit AGENTS.md context: /agents [on|off|reset] [--next|--restart]",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			if (words.length > 1) {
				return ["--next", "--restart"]
					.filter((v) => v.startsWith(words[words.length - 1]))
					.map((v) => ({ value: `${words.slice(0, -1).join(" ")} ${v}`, label: v }));
			}
			return ARGS.filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v, description: `AGENTS context ${v}` }));
		},
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const flags = words.filter((w) => w.startsWith("--"));
			const [verb, ...extra] = words.filter((w) => !w.startsWith("--"));
			const bad = flags.find((f) => f !== "--next" && f !== "--restart");
			if (!verb && !flags.length) return openTree(ctx);
			if (!verb || !ARGS.includes(verb) || extra.length || bad || flags.length > 1) {
				return ctx.ui.notify(`Usage: /agents, or /agents on|off|reset [--next|--restart] (got "${args}")`, "warning");
			}
			const mode: Mode = flags[0] === "--next" ? "next" : flags[0] === "--restart" ? "restart" : "save";
			const cur = readConfig().state;
			const next = verb === "reset" ? emptyState() : { ...cur, allOff: verb === "off" };
			await apply(ctx, next, mode);
		},
	});
}
