# pi-agents-toggle

Toggle, edit, or empty your `AGENTS.md` / `CLAUDE.md` context files from inside [Pi](https://pi.dev), without touching the files on disk.

Useful for feeling "pure" model behavior, A/B testing a single rule, or muting one noisy instruction for a session.

```
 AGENTS context                               1 file · 3/5 lines · session/forward · vim
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

The status bar shows `AGENTS on`, `AGENTS off`, or `AGENTS 3/5 ✎`.

### The tree

All loaded context files, in Pi's load order: the global file (`~/.pi/agent/AGENTS.md`) first, then every directory from `/` down to your cwd. Each file is parsed into a tree: headings contain their content, bullets contain their indented sub-bullets, and numbered (`1.`) and lettered (`a)`) items nest the same way. Wrapped paragraphs and code fences are one row each. Turning a parent off turns off everything under it.

| Action | Default keys | Vim keys (`v` to switch) |
|---|---|---|
| Move | `↑` `↓` `PgUp` `PgDn` | `j` `k` `gg` `G` `Ctrl-d` `Ctrl-u` |
| Fold / unfold | `←` `→` | `h` `l` `za` |
| Toggle line or file | `space` | `space` `x` `dd` |
| Edit line (session only) | `e` | `i` `cc` |
| Edit whole file on disk | `E` | `:e` |
| Undo | `u` | `u` |
| All off / all on | `0` / `1` | `:off` / `:on` |
| Reset | `r` | |
| Apply and close | `enter` / `esc` | `:w` `ZZ` `enter` `esc` |
| Cancel | `q` | `:q!` `ZQ` |

The vim setting is remembered in `~/.pi/agent/agents-toggle.json`.

## How it applies

Changes are a **session overlay**. They take effect from your next message and are stored in the session, so they survive `/resume` and follow `/tree` branches. The files on disk change only if you edit a whole file with `E` and confirm the write.

They apply **forward**: Pi appends a system-prompt update that replaces the `project_context` section, so the model sees the new rules from that point on and its earlier turns stay as they were. This keeps the prompt cache. For a fully clean test, run `/agents off` and then `/new`.

Line toggles are matched by text, not position, so edits made to the file outside Pi don't shift them onto the wrong line.

## License

MIT
