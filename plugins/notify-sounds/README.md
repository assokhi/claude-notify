# notify-sounds

Play a notification sound from Claude Code:

- **Question / needs input** → `Notification` hook → `notification.wav`
- **Turn finished** → `Stop` hook → `complete.wav`

Cross-platform — works on **macOS, Windows, Linux**. No config, no dependencies
beyond Node (which Claude Code already ships with).

## How it works

A `Notification` and a `Stop` hook each run
`node scripts/play.js <kind>`. Because the player is a Node script (not a bash
one-liner), it runs identically on every OS. `play.js` detects the platform and
calls the native player:

| OS      | Player used                                   |
| ------- | --------------------------------------------- |
| macOS   | `afplay`                                       |
| Windows | PowerShell `System.Media.SoundPlayer`          |
| Linux   | `paplay` → `pw-play` → `aplay` → `ffplay` → `play` (first available) |

Sounds are bundled `.wav` files in `sounds/` (wav plays on every platform), so
no system sound theme is required. If no player is found the hook stays silent —
it never errors or blocks your session (`async: true`).

## Customizing the sounds

Replace `sounds/notification.wav` and `sounds/complete.wav` with any `.wav` you
like (keep the filenames).

## Note

`Stop` fires at the end of **every** assistant turn, not only large tasks —
Claude Code has no "big-task-only" event.
