# claude-notify

A Claude Code plugin marketplace. Ships:

- **notify** — smart notifications. Classifies each turn from the transcript
  (task done / review / question / plan ready / session limit / API error) and
  fires a native desktop popup + per-status sound + terminal bell, with
  suppression, per-status config, and best-effort click-to-focus. Cross-platform
  (macOS / Windows / Linux), pure Node, zero dependencies. See
  [plugins/notify](plugins/notify).

## Install

```
/plugin marketplace add <owner>/claude-notify     # GitHub repo, or a local path
/plugin install notify@claude-notify
```

Then restart Claude Code (or open `/hooks` once) so the hooks load.

Local testing without GitHub:

```
/plugin marketplace add /home/sokhi/projects/claude-notify
/plugin install notify@claude-notify
```

## Uninstall

```
/plugin uninstall notify@claude-notify
```

## Configuration

`notify` works with no config. To customize, create
`~/.claude/claude-notify/config.json` — see
[plugins/notify/README.md](plugins/notify/README.md) and
[plugins/notify/config.example.json](plugins/notify/config.example.json).
