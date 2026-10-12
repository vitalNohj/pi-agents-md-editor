# pi-agents-toggle

Toggle, edit, or empty your `AGENTS.md` / `CLAUDE.md` context files from inside [Pi](https://pi.dev), without touching the files on disk.

Useful for feeling "pure" model behavior, A/B testing a single rule, or muting one noisy instruction.

```
 AGENTS context                                        1 file · 3/5 lines · global · vim
 ───────────────────────────────────────────────────────────────────────────────────────
 ▾ ● cwd     ~/proj/AGENTS.md  5 lines
   ▾ ● # Project rules
       ○ - Always end replies with the word BANANA.  (off)
     ▾ ✎ - Secret code word is OTTER7.  (edited)
         ● - nested: reply in lowercase
       ● 1. numbered rule
 ───────────────────────────────────────────────────────────────────────────────────────
```

## Install

```bash
pi install git:github.com/vitalNohj/pi-agents-toggle
```

## Use

| Command | Effect |
|---|---|
| `/agents` | Open the tree window |
| `/agents off` | Send no context files at all |
| `/agents on` | Turn context files back on (line toggles are kept) |
| `/agents reset` | Drop every toggle and edit |

`off`, `on` and `reset` take `--next` or `--restart` to choose an [apply mode](#apply-modes); without a flag they save only.

The status bar shows `AGENTS on`, `AGENTS off`, or `AGENTS 3/5 ✎`. A suffix tells you when the current session differs from what new sessions get:

- `(next session)`: you saved a change, but this session keeps the context it started with.
- `(next prompt)`: this session swaps to the new context on your next message.

### The tree

All loaded context files, in Pi's load order: the global file (`~/.pi/agent/AGENTS.md`) first, then every directory from `/` down to your cwd. Each file is parsed into a tree: headings contain their content, bullets contain their indented sub-bullets, and numbered (`1.`) and lettered (`a)`) items nest the same way. Wrapped paragraphs and code fences are one row each. Turning a parent off turns off everything under it.

| Action | Default keys | Vim keys (`v` to switch) |
|---|---|---|
| Move | `↑` `↓` `PgUp` `PgDn` | `j` `k` `gg` `G` `Ctrl-d` `Ctrl-u` |
| Fold / unfold | `←` `→` | `h` `l` `za` |
| Toggle line or file | `space` | `space` `x` `dd` |
| Edit line (overlay, file untouched) | `e` | `i` `cc` |
| Edit whole file on disk | `E` | `:e` |
| Undo | `u` | `u` |
| All off / all on | `0` / `1` | `:off` / `:on` |
| Reset | `r` | |
| Apply and close (then pick a mode) | `enter` / `esc` | `:w` `ZZ` `enter` `esc` |
| Cancel | `q` | `:q!` `ZQ` |

## How it works

Toggles and edits are a **global overlay** on top of the files on disk, saved in `~/.pi/agent/agents-toggle.json` (along with the vim setting). The files themselves change only if you edit a whole file with `E` and confirm the write.

**Every session keeps the context it started with.** A session reads its AGENTS context from its own saved system prompt, so later changes, whether through `/agents` or by editing the files, never leak into a session that has already been prompted, even after `/resume`.

### Apply modes

When you apply changes, you choose what happens to the session you're in. All three save the change for new sessions.

| Mode | Current session | Prompt cache |
|---|---|---|
| **Save only** (default) | Untouched. Start a new session (`/new`) to use the change. | Untouched |
| **Swap on next prompt** (`--next`) | On your next message, the AGENTS block in the opening system prompt is replaced in place. The model sees one prompt, as if it always had the new context. The session file keeps its history; the swap is applied to every request from then on. | Rebuilt once |
| **Restart now** (`--restart`) | The session is copied with the AGENTS block replaced in its saved history, and Pi switches to the copy. The original session is kept as it was. | Rebuilt once |

Neither swap removes what the conversation itself has taught the model. If it quoted the old rules earlier, those quotes are still in the history. For a fully clean test, use save only and `/new`.

Line toggles are matched by text, not position, so edits made to the file outside Pi don't shift them onto the wrong line. `pi --no-context-files` is respected: the extension sends nothing when Pi was started without context files.

## License

MIT
