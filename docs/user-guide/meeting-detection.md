# Meeting detection

When a call starts in Zoom, Microsoft Teams, Google Meet or Webex, NexQ shows a small prompt at the top of your screen. Click **Start NexQ** to begin transcribing and get the AI copilot. The meeting is named after the call, so you can find it later.

## How it works

NexQ checks which app is using your microphone every 3 seconds (you can change this from every second to every 10 seconds). Each check takes a few milliseconds. When a call app holds the microphone for a few seconds, NexQ treats that as a meeting. **It never listens to audio before you click Start**: it only reads which process has the microphone open, and the titles of that app's windows.

- **Desktop apps.** Zoom, Teams and Webex count as soon as they use the microphone.
- **Browsers.** A browser that uses the microphone counts only when its active tab is a meeting (Google Meet, Teams or Zoom on the web). Browsers use the microphone for other things too, such as voice typing and recorders.
- **One prompt per call.** If you dismiss the prompt, it won't come back for the same call. A call counts as ended about 10 seconds after the app releases the microphone, and the prompt closes then.
- **Never while recording.** No prompt appears while a NexQ meeting is already running.

## The meeting name

The prompt fills in the call's title when the app shows one:

| App | Title source |
|---|---|
| Microsoft Teams | The meeting window's title (`Weekly sync \| Microsoft Teams` gives "Weekly sync") |
| Google Meet | The tab title when Meet shows the calendar event's name. A bare meeting code (`abc-defg-hij`) means no title. |
| Zoom | Zoom's meeting window is usually titled just "Zoom Meeting", so the name is often blank. |
| Webex | The meeting window's title, when it has one |

Click the name in the prompt to type your own. NexQ puts it in front of the usual name, for example `Weekly sync — Meeting 2026-10-23 15:02`. With no title, the app's name is used: `Zoom — Meeting 2026-10-23 15:02`.

The chevron next to **Start NexQ** picks the meeting type (Team Meeting, Interview, Lecture…) for this call.

## Settings

**Settings → General → Detect meetings** has these options:

- **On/off.** Detection is on by default.
- **Apps.** Zoom, Microsoft Teams, Google Meet, Webex, Slack huddles and Discord. Slack and Discord are off by default.
- **Start as.** The meeting type a prompt starts with.
- **Check for calls.** How often NexQ checks: every 1, 2, 3 (default), 5 or 10 seconds.
- **Hide the prompt after.** 30 seconds, 1 minute, 2 minutes, or until the call ends. The timer pauses while your mouse is over the prompt.

Keyboard: **Enter** starts the meeting and **Esc** dismisses the prompt. When [Hide from screen share](../../README.md#privacy) is on, the prompt is hidden from screen sharing too.

> Meeting detection is available on Windows. macOS support is planned.

Please always let the other participants know that the meeting is being transcribed.
