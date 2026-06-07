# claude-notify

A Claude Code plugin marketplace. Currently ships one plugin:

- **notify-sounds** — plays a sound when Claude asks a question / needs input,
  and a different sound when Claude finishes a turn. Cross-platform
  (macOS / Windows / Linux). See [plugins/notify-sounds](plugins/notify-sounds).

## Install

```
/plugin marketplace add <owner>/claude-notify     # GitHub repo, or a local path
/plugin install notify-sounds@claude-notify
```

Then restart Claude Code (or open `/hooks` once) so the hooks load.

Local testing without GitHub:

```
/plugin marketplace add /home/sokhi/projects/claude-notify
/plugin install notify-sounds@claude-notify
```

## Uninstall

```
/plugin uninstall notify-sounds@claude-notify
```
