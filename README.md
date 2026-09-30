# dsh-plugin-ptc-bash

English | [中文](README.zh.md)

`ptc-bash` provides a **Git Bash-first** `bash` tool in dsh Windows sessions and brings the AGENTS.md instruction chain into the system prompt.

## Features

- **PTC from the first turn**: built on the official PTC preset, the tool surface is only `run_code` and the subagent tools.
- **Git Bash first on Windows**: adds a `dsh-bash-win` row whose parameter set matches the official `bash` (`description` / `timeoutMs` / `run_in_background`).
- Keeps the official `pwsh` row as a fallback shell; every other row matches the official `ptc` line for line.
- Adds a `workspace-instructions` row: the AGENTS.md / CLAUDE.md instruction chain is injected along with the system prompt.
- The preset registers with the host **declaratively**, so new sessions can select it without copying any file by hand.

## Installation

### Install from GitHub (recommended)

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-ptc-bash
```
### Install from a local directory

```bash
dsh plugin --profile web add ./dsh-plugin-ptc-bash
```
After restarting dsh web, "PTC + Bash mode" appears in the preset picker for new sessions.

## Usage

- Entry point: when creating a session, pick "PTC + Bash mode" in the preset picker (preset id `ptc-bash`); selecting it lets you start the new session.
- Ordinary commands in a session go through `bash` (Git Bash); when you need PowerShell, the `pwsh` tool is still available.
- The preset's loader rows take no config by default and use all defaults; to change something, add `config` to the corresponding row in `presets/ptc-bash/agent.cordis.yml` (see [docs/design-notes.md](docs/design-notes.md) for the available keys).

## Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-ptc-bash
```

## Technical notes

- Requires `@deepseek-ai/dsh` `^0.2.0-rc.1`; an incompatible upgrade is rejected at startup with the reason on stderr.
- The preset id must not collide with another declared preset; on a collision this package only warns and does not register.
- Editing `presets/ptc-bash/**` does not trigger a hot remount: you must restart `dsh web`, and the change only affects **newly opened sessions**.
- The `bash` tool defaults to a `120000` ms timeout, a `600000` ms per-call cap, and a `64000`-byte per-stream output cap (a truncated result gives the spill file path).
- Collect background jobs with `job_output` / `job_list` / `job_kill` (requires `dsh-jobs` and `dsh-tool-jobs` to be loaded).

## Further reading

Contracts, troubleshooting, and internals: see [docs/design-notes.md](docs/design-notes.md).

## License

MIT © 2026 HenTaiCJN
