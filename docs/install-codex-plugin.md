# Installing the Codex Plugin in Claude Code

**Audience:** macOS Apple Silicon, using both the Claude Desktop app *and* the terminal `claude` CLI.
**Goal:** `/codex:review`, `/codex:adversarial-review`, and the optional stop-time review gate, working everywhere.

This guide is written from a real install, not generic docs. The order matters — several steps prevent a class of common errors that AI assistants tend to misdiagnose.

---

## What you're installing

| Piece | What it does |
|---|---|
| Codex CLI (`@openai/codex` npm package) | The local binary that does the actual work. Plugin shells out to it. |
| `codex-plugin-cc` (Claude Code plugin) | Wires `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel`, plus the `codex:codex-rescue` subagent. |
| Review gate (optional, recommended) | Stop-time hook that requires a fresh Codex review before Claude can end a turn. |

Plugin source: <https://github.com/openai/codex-plugin-cc>

---

## Prerequisites

- macOS Apple Silicon (M1/M2/M3/M4)
- Homebrew installed at `/opt/homebrew` (run `brew --prefix` to confirm)
- Node.js + npm installed (any 18.18+)
- A ChatGPT account (Free tier works) **or** an OpenAI API key — the plugin uses whichever you authenticate with via `codex login`. Plugin usage counts against your Codex limits.

---

## Step 0 — Decide which install path you're on

Run these in a terminal:

```bash
ls -la "$(which claude)"
which node
ls -ld "$(npm config get prefix)/lib/node_modules"
```

Three pieces of information come back:

1. **Where the `claude` binary lives.** If it's a symlink into `~/.local/share/claude/versions/X.Y.Z`, you're on the **native installer**. If it's `/opt/homebrew/bin/claude`, you're on **Homebrew**. If it's somewhere under `~/.nvm`, `~/.npm-global`, or `~/.volta`, you're on **npm-global**.
2. **Where Node lives.** `/opt/homebrew/bin/node` = Homebrew Node (good). `/usr/local/bin/node` = pkg-installer Node (root-owned — read Step 2 carefully).
3. **Who owns your global node_modules.** If the listing shows `root  wheel`, you'll hit `EACCES` on every `npm install -g` and need the prefix fix in Step 2.

Write down your three answers. They drive the rest of the steps.

---

## Step 1 — Update both Claude Code surfaces to ≥ 2.1.122

**Why this matters:** the `/plugin` slash command (`/plugin marketplace add …`, `/plugin install …`) was added in a recent build. Older versions answer with `"/plugin isn't available in this environment."` and your Claude assistant will spin trying to debug a non-existent permission issue. The fix is just to update.

There are two Claude Code installations on a macOS machine that runs both surfaces — they update independently. **You must update both.**

### 1a. Update the terminal CLI

Pick the path that matches what `ls -la $(which claude)` showed in Step 0:

| Install method | Update command |
|---|---|
| Native installer (`~/.local/share/claude/...`) | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Homebrew | `brew upgrade claude-code` |
| npm-global | `npm update -g @anthropic-ai/claude-code` |

Verify:

```bash
claude --version
```

Should print `2.1.122` or higher.

### 1b. Update the Claude Desktop app

The desktop app **bundles its own copy of Claude Code** at `~/Library/Application Support/Claude/claude-code/<version>/claude.app/`. Updating the terminal CLI does **not** update the desktop app's bundled CLI.

In Claude Desktop, top menu bar → **Claude → Check for Updates…**, install whatever it offers, then quit (Cmd+Q) and relaunch.

To verify the desktop app's bundled version, with Claude Desktop running:

```bash
ls ~/Library/Application\ Support/Claude/claude-code/
```

The folder name *is* the version. Confirm it's ≥ 2.1.122.

> **Common trap:** people update the terminal CLI, restart the desktop app, and assume both are updated. They are not. Verify both versions independently.

---

## Step 2 — Install the Codex CLI

```bash
npm install -g @openai/codex
```

If that succeeds, skip to Step 3.

If you get `EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@openai'`, your Node was installed via the official `.pkg` installer with root-owned `/usr/local`. **Do not solve this with `sudo`** — it works once but every future global install (and every update of `@openai/codex`) will also need sudo, and packages installed as root run their postinstall scripts as root. Reconfigure the npm prefix instead:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g @openai/codex
```

This is a one-time setup. Every future `npm install -g <anything>` will be user-owned and sudo-free.

Verify:

```bash
codex --version
```

Should print `codex-cli 0.128.0` or similar.

---

## Step 3 — Make `codex` discoverable to the Claude Desktop app

**Why this matters:** macOS GUI apps (including Claude Desktop) get their `PATH` from `/etc/paths.d/*`, **not** from your `~/.zshrc`. So the line we just added to `~/.zshrc` makes `codex` visible to terminal shells but **not** to subprocesses spawned by Claude Desktop. You'll see Claude in the desktop app fail with "codex: command not found" even though `codex` works fine in your terminal.

The fix is a one-line symlink into a directory the GUI PATH already includes:

```bash
ln -s ~/.npm-global/bin/codex /opt/homebrew/bin/codex
```

`/opt/homebrew/bin` is on the macOS GUI PATH because Homebrew adds it via `/etc/paths.d/homebrew` at install time. Confirm with:

```bash
cat /etc/paths.d/homebrew
```

If that file doesn't exist, Homebrew either isn't installed or wasn't installed in the standard way — stop here and fix Homebrew first.

**This step is needed even if you used Homebrew Node**, because the plugin invokes `codex` from a non-shell subprocess that doesn't load `~/.zshrc`.

Verify the symlink resolves and works:

```bash
ls -la /opt/homebrew/bin/codex
/opt/homebrew/bin/codex --version
```

The `ls` should show `codex -> /Users/<you>/.npm-global/bin/codex`. The version command should print `codex-cli …`.

---

## Step 4 — Authenticate Codex

```bash
codex login
```

Follow the OAuth flow. This writes `~/.codex/auth.json` (mode 600). Both ChatGPT and API-key auth work — `codex login` walks you through whichever applies.

Verify:

```bash
ls -la ~/.codex/auth.json
```

Should be present, ~4 KB, mode `-rw-------`.

---

## Step 5 — Install the plugin in Claude Code

In a fresh terminal, run `claude`. **Important: it must be a fresh terminal session** (one started after you updated the CLI in Step 1a) — otherwise you're still running the old binary.

Inside the Claude Code session, run these one at a time:

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup --enable-review-gate
```

What each does:

- **marketplace add** — registers `openai/codex-plugin-cc` as a plugin source. Doesn't install anything yet.
- **install** — copies the plugin into `~/.claude/plugins/cache/openai-codex/codex/<version>/` and adds it to `~/.claude/settings.json` under `enabledPlugins`.
- **/reload-plugins** — picks up the new plugin in the current session without restarting.
- **/codex:setup --enable-review-gate** — runs the plugin's setup script. It detects Codex, verifies auth, and enables the stop-time review gate.

If `/codex:setup` complains that Codex isn't found — the plugin is shelling out and not finding `codex` on its PATH. That's the symptom Step 3 prevents. Double-check the symlink at `/opt/homebrew/bin/codex` actually exists and resolves.

---

## Step 6 — Verify

Run these in a terminal (outside Claude Code) to confirm everything landed correctly:

```bash
# Plugin manifest installed
cat ~/.claude/plugins/installed_plugins.json | grep -A 8 '"codex@openai-codex"'

# Marketplace registered
cat ~/.claude/plugins/known_marketplaces.json | grep -A 5 '"openai-codex"'

# Plugin enabled in user settings
grep '"codex@openai-codex"' ~/.claude/settings.json

# Plugin assets in place
ls ~/.claude/plugins/cache/openai-codex/codex/*/commands/

# Codex auth present
ls -la ~/.codex/auth.json

# Codex on GUI PATH
ls -la /opt/homebrew/bin/codex

# Review gate enabled for this workspace
find $TMPDIR/codex-companion -name "state.json" -exec cat {} \;
```

You should see:

- Plugin entry with `"version": "1.0.X"` and a recent `installedAt`
- Marketplace entry pointing at `openai/codex-plugin-cc`
- `"codex@openai-codex": true` in `enabledPlugins`
- Files: `adversarial-review.md`, `cancel.md`, `rescue.md`, `result.md`, `review.md`, `setup.md`, `status.md`
- `~/.codex/auth.json` present, mode 600
- Symlink: `codex -> /Users/<you>/.npm-global/bin/codex`
- State file with `"stopReviewGate": true`

If all eight checks pass, the install is complete at the data layer.

---

## Step 7 — Activate in the Claude Desktop app

The Claude Desktop app freezes its plugin set at session start. If you installed the plugin while a desktop session was running, **that session will not have it loaded** — only sessions started *after* the install will.

To activate:

1. Quit Claude Desktop fully — **Cmd+Q**, not just close the window.
2. Relaunch.
3. Open a new chat.

In the new chat, you should be able to run `/codex:review`, `/codex:adversarial-review`, etc. The stop-review-gate hook will fire automatically when Claude tries to end a turn without a fresh Codex review.

Quick sanity check inside a new desktop session:

```
/codex:status
```

Should report Codex as ready and the review gate as enabled. If it says Codex is not found, the symlink in Step 3 is the culprit 95% of the time — re-verify `/opt/homebrew/bin/codex` exists and `codex --version` runs from a vanilla shell.

---

## First real run

```
/codex:review --background
/codex:status
/codex:result
```

For adversarial review on a specific concern:

```
/codex:adversarial-review --base main challenge whether the retry logic is safe under partial failure
```

The text after the flags is steering — focus on hidden assumptions, race conditions, rollback safety, anything you want pressure-tested.

---

## Troubleshooting

### `/plugin isn't available in this environment`
Your Claude Code is older than 2.1.122. Re-do Step 1. If you're sure you ran the update command, you may be in a session that started before the update — quit and start fresh.

### `codex: command not found` from inside Claude Desktop
The symlink in Step 3 is missing or broken. Run `ls -la /opt/homebrew/bin/codex`. If it doesn't exist, re-create it. If it exists but `/opt/homebrew/bin/codex --version` errors out, the symlink target moved — recreate pointing at the current `~/.npm-global/bin/codex`.

### `codex` works in terminal but not in Claude Desktop
Same as above. Terminal shells read `~/.zshrc` (which has `~/.npm-global/bin` on PATH). GUI apps don't. The symlink is the bridge.

### `EACCES` on `npm install -g`
Don't sudo. Run the prefix-reconfig block in Step 2.

### `/codex:setup` says review gate isn't enabled after I enabled it
The state is per-workspace, stored at `$TMPDIR/codex-companion/<workspace-slug>-<hash>/state.json`. macOS occasionally clears `$TMPDIR` (long idle, OS major version upgrades). If the state vanishes, just re-run `/codex:setup --enable-review-gate`.

### `/codex:review` invoked but nothing happens
Check `/codex:status`. If a job is stuck in `pending`, run `/codex:cancel <job-id>` and retry. If Codex itself is unreachable, `codex --version` from a shell will tell you whether the binary is broken vs the auth.

### Plugin commands missing from a desktop session
The desktop app freezes plugins at session start. Quit (Cmd+Q) and relaunch. New sessions pick up `~/.claude/plugins/installed_plugins.json` fresh.

---

## Why this guide is opinionated

Every step here exists because we hit the failure mode it prevents:

- Step 1 dual-update — updating only the terminal CLI leaves the desktop bundled CLI on an old version that can't run `/plugin`.
- Step 2 npm prefix — `sudo npm install -g` works once but creates root-owned packages that bite later.
- Step 3 symlink — `~/.zshrc` doesn't reach GUI subprocesses on macOS, so PATH-only fixes leave the desktop app blind to `codex`.
- Step 7 quit-and-relaunch — installing the plugin while a desktop session is running doesn't activate it in that session.

If your AI assistant guides you down a different path on any of these, push back — these are the specific traps it's likely to fall into.
