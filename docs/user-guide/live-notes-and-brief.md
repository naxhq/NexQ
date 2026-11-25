# Live Notes and the Brief

Two helpers can work beside the live answers during a meeting. Both are **off until you turn them on**.

- **Live notes** write a tidy page of topics, decisions, tasks and questions while you talk.
- The **Brief** keeps a short sheet of what your workspace already knows about the topic being discussed now, so live answers can use it.

They run on a model of their own, with their own limit, and they never slow down or block a live answer.

## Prerequisites

- An LLM provider set up ([AI Providers Guide](ai-providers.md))
- For the brief, a [workspace](workspaces.md) with something in it: past meetings, documents, a folder you allowed, talking points

## Show the panels

Both are panels in the meeting window. They are hidden in the default layout. Choose **Layout > Panels > Live notes** (or **Brief**), or pick the **Notes** layout, which puts them side by side on the right ([Meeting window layout](meeting-layout.md)). A hidden panel keeps working.

## Live notes

### Turn them on

1. Open the **Live notes** panel in a running meeting.
2. Under **Turn on for**, choose **This meeting** or **Every meeting**.
3. Click **Turn on notes**.

**This meeting** turns notes off again when the meeting ends. **Every meeting** starts them in each new meeting.

You can also use the **Take live notes** switch in **Settings > Live Notes and Brief**. To stop notes for the meeting you are in, choose **Stop notes for this meeting** in the panel's **...** menu.

### What you get

A page, not a chat. It is laid out as:

- **Topics** as headings, each with the time it started
- A summary line under a topic when there is one
- Notes, **Decision**, **Task** and **Question** lines, each marked in its own way (not only by colour)
- People, places, organisations, dates and numbers set apart. **Colour people and places** turns the tint on or off. Dates and numbers are set in heavier type either way

Click a time to jump to that moment in the transcript.

### Make them yours

You can edit any line. Click it and press `Enter` (or `F2`) to edit, `P` to pin it, `Delete` to remove it. A line's **...** menu has **Edit**, **Pin**, **Add a line below**, **Copy as Markdown**, **Jump to ... in the transcript** and **Delete**. You can change a line between **Note**, **Decision**, **Task** and **Question**. **Undo** at the bottom takes back your last change.

NexQ never changes or removes a line you edited or pinned. It only touches the last two topics, adds at most 12 changes in one update, and caps the length of a line.

### When they update

With **Updates** on **Automatic** (the default), NexQ updates the notes:

- After about 100 new words and a short pause of 2 seconds, and at least 20 seconds after the last update
- After 90 seconds without an update, if at least 15 new words are waiting
- When you click **Update now** or press `N` in the meeting window
- Once more when the meeting ends. It never delays ending the meeting

Nothing runs on silence, and only one update runs at a time. If a live answer is being written, the notes wait. Choose **Manual** (or **Update only when I ask** in the **...** menu) to update only when you ask.

The panel tells you what it is doing: **Waiting for speech**, **Taking notes**, **Paused**, **Stopped**, or **Waiting for you** (in manual mode).

### Model, detail and language

In **Settings > Live Notes and Brief**, or **Model, detail and limit** in the panel menu:

| Setting | Choices |
|---------|---------|
| **Model** | **Automatic** uses the cheapest model of your active provider. Or pick any provider, model and effort |
| **Updates** | **Automatic** or **Manual** |
| **Detail** | **Brief**, **Standard** or **Detailed** |
| **Language of the notes** | **The meeting's language**, or one of 12 languages |
| **Limit per meeting** | 30k, 60k, 120k, 240k or 500k tokens |

If the model can't answer (no key, plan limit, server not running), NexQ doesn't switch to another one. The panel says **Notes stopped** or **Notes paused** with the reason, and offers **Change model** and **Try again**. Three failures in a row pause the notes. NexQ can also read notes from a small local model that answers in plain lines instead of structured output, and it drops anything it can't read.

### Cost and the limit

Notes use your provider's tokens, so they cost what your provider charges for them. NexQ keeps each request small: it sends the new lines of the transcript and a short outline of the notes so far, not the whole meeting again. It counts the tokens the provider reports as new input plus the output (or an estimate when the provider doesn't say). The footer shows it, for example **12k of 120k tokens**.

The default limit is **120k tokens** per meeting. When the notes reach it, they pause and the panel asks:

> **Keep taking notes?** The notes used 120k tokens, the limit you set. Keep going adds 120k more.

Choose **Keep going** to continue (it adds the same amount again) or **Stop** to keep the notes you have. Nothing more is sent until you choose. Pick a smaller limit under **Limit per meeting** if you want a tighter ceiling.

With a Claude, Codex or Antigravity subscription, the notes use your plan rather than money, and a plan limit pauses them with the reason.

### Keep and export

Notes are saved as you go, with the meeting. Open a past meeting and use the **Notes** tab: it shows the same page, editable, with **Copy as Markdown** and **Save as file** (a `.md` file). In the live panel, **Copy all as Markdown** is in the **...** menu.

### What notes see

Live notes read **only the transcript**: the new lines with their time and speaker, and the notes so far. They never read your documents, folders, tools, memory or talking points, and they don't use the workspace at all. The transcript goes to the model you chose for notes. A local model keeps it on your PC.

## The brief

### Turn it on

The brief is turned on **per workspace**. In the **Brief** panel, click **Turn on the brief**. From then on it starts in every meeting of that workspace. **Turn the brief off** in the panel's **...** menu turns it off for the workspace. The brief is always off in a workspace until you do this.

### What you get

A short sheet that follows the conversation:

- A line with the **topic** being discussed
- Up to **6 facts** from your workspace, each with a **source chip** you can click to open the meeting, document or note it came from
- **Earlier points**, folded away
- How old the sheet is (for example "12 s ago")

If nothing in the workspace matches, the sheet says "Nothing in the workspace matches this topic."

A fact only appears if it cites a passage that was really sent to the model, and if its names and numbers are in that passage. When the topic changes, the old sheet is hidden at once ("The old sheet is hidden so answers do not use it") and a new one is prepared.

**Live answers use it.** Every live answer carries the newest sheet when it is less than 4 minutes old and belongs to the current workspace setup. Answers never wait for it. The panel says **Answers use this brief while it is fresh**, or **Too old for answers. Refresh to use it again.** If you change what the meeting uses, the sheet is cleared.

### How it works

1. About every 30 seconds of speech, NexQ searches the workspace **on your PC**. This is a keyword search over the workspace's past meetings, documents, folders you allowed ([Search its text](workspaces.md#folder-text-search)), talking points marked as AI context and saved memory. It makes no model call.
2. It asks the model for a new sheet only when half of the top passages changed, the topic changed, or you click **Refresh**, and never more often than every 45 seconds. It sends about 2,500 tokens of passages, the recent transcript and your saved memory.
3. The model writes the sheet in at most 350 tokens.

**Pause** and **Resume** stop and restart it, and **Refresh** makes a new sheet now. The panel says **Listening for the topic**, **Checking the workspace**, **Paused** or **Stopped**.

### Model and the limit

**Model and limit** in the panel's **...** menu, or **Settings > Live Notes and Brief**, set the model (**Automatic** is the cheapest model of your active provider) and the **Limit per meeting**: 30k, 60k, 120k (the default) or 240k tokens. A brief uses roughly 60k tokens an hour of conversation, so the default covers about two hours.

When the limit is reached, the brief pauses and asks **Keep the brief going?** with **Keep going** (adds the same amount) or **Stop**. If the model fails it says so with the reason and **Change model** and **Try again**. It never switches to another provider on its own.

The brief can't be exported, since it is only there for the live moment.

### What the brief sends

The recent transcript, the passages found in the workspace for this topic and your saved memory go to the model you chose for the brief. Only the meeting's own workspace, and what it also uses, is searched. The brief never opens files on its own. Files that look like secrets (names like `.env`, `*.key`, or containing `credential`, `secret`, `token` or `password`) are not indexed in the first place.

## Privacy at a glance

| | Notes | Brief |
|---|-------|-------|
| Sends to the model | The transcript lines and the notes so far | The transcript, passages from the workspace, saved memory |
| Reads the workspace | **Never** | Yes, only the meeting's workspace and what it uses |
| Runs | On the model you pick, with your key or plan | The same |
| Off by default | Yes | Yes |
| Can use a local model | Yes | Yes |

## Tips

- **Start with Automatic and Standard.** They use the cheapest model your provider offers.
- **Use a local model for notes** if you don't want the conversation to leave your PC. It can be slower on a long meeting.
- **Turn the brief on in the workspaces that have a lot of material**, such as a client you have talked to many times.
- **Press N before the end** if you want the notes right up to the last minute. A final update runs anyway when you end the meeting.

## Next Steps

- [Meeting window layout](meeting-layout.md): put the panels where you want them
- [Workspaces](workspaces.md): what the brief searches
- [Workspace chat](workspace-chat.md): ask questions after the meeting
- [AI Providers Guide](ai-providers.md): choose the model for notes and the brief
