# Live Notes and the Brief

Two helpers can work beside the live answers during a meeting. Both are **off until you turn them on**.

- **Live notes** write a tidy page of topics, decisions, tasks and questions while you talk.
- The **Brief** keeps a short sheet of what your workspace already knows about the topic being discussed now, so live answers can use it.

They run on a model of their own, with their own limit, and they never slow down or block a live answer.

## Prerequisites

- An LLM provider set up ([AI Providers Guide](ai-providers.md))
- For the brief, a [workspace](workspaces.md) with something in it: past meetings, documents, a folder you allowed, talking points

## Show the panels

Both are panels in the meeting window. They are hidden in the default layout. Choose **Layout > Panels > Live notes** (or **Brief**), or pick the **Notes** layout, which puts them side by side on the right ([Meeting window layout](meeting-layout.md)). Hiding the panel doesn't stop the notes or the brief.

## Live notes

### Turn them on

1. Open the **Live notes** panel in a running meeting.
2. Under **Turn on for**, choose **This meeting** or **Every meeting**.
3. Click **Turn on notes**.

Before you turn them on, the panel says which model they will use, for example **Automatic, uses Ollama · llama3.2 (active model)**.

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
- When the meeting ends, once more, until what is left is covered or about 20 seconds are used. It never delays ending the meeting

Nothing runs on silence, and only one update runs at a time. If a live answer is being written, the notes wait.

**Manual** (or **Update only when I ask** in the **...** menu) never runs unasked, and that includes the end of the meeting. The end only marks what was never sent (the notes then say **Not updated automatically**), and **Update notes** and **Keep going** work from the saved transcript like for any other finished meeting, in one press.

**How the notes ended.** When the meeting is over, the panel and the **Notes** tab of the meeting say how the notes ended, with a heading and one sentence:

| Heading | Sentence |
|---------|----------|
| **Finished** | The notes cover the whole call. |
| **Stopped at the limit** | The notes stopped at the limit you set. |
| **Stopped by an error** | The notes stopped because of an error (the error follows). |
| **Stopped by a usage limit** | The notes stopped because your plan's usage limit was reached. |
| **Paused** | The notes were paused when the meeting ended. |
| **Not updated automatically** | The notes were on manual, so they were not updated by themselves. |
| **Stopped early** | The last update ran out of time. |
| **Stopped** | You stopped the notes, or turned them off, before the meeting ended. |
| **Interrupted** | NexQ was closed before the notes were finished. |
| **Nothing to note** | The notes read the whole call and found nothing to write down. (The notes page then says **Nothing to note** instead of being empty.) |
| **Stopped for another meeting** | The notes stopped because another meeting started (while they were being updated). |

**Not covered.** NexQ works out which part of the call never reached the notes from what was saved, so it is known whatever ended them (even if NexQ was closed in the middle). The panel and the tab say so, for example **Not covered: 2:00 to 40:00**.

**Update notes** covers it. One press makes as many updates over the saved transcript as it takes, until everything is covered, the limit is reached or an update fails (at most about 10 minutes in all). If the notes ended at the limit, **Keep going** raises the limit by the amount in your settings and then covers the rest in the same press. These two buttons also show up after the meeting, in the **Notes** tab. While the update works, between its passes too, the state stays **Taking notes** and no button is offered. It says why it can't run when that is so: another meeting is live (it never competes with a live meeting: it is refused while another meeting is live, and an update that is running stops at once when a new meeting starts, saying **Stopped for another meeting**), there are no notes, nothing new to add, the limit was reached, or the saved transcript has nothing in that part (the **Not updated** notice). Deleting the meeting, or stopping the notes, stops an update that is running. At the end of a live meeting, after three failures NexQ makes one last bounded try, unless the cause can't change by trying (no key) or it is a plan limit.

The panel tells you what it is doing, in words:

| What it says | Meaning |
|--------------|---------|
| **Off** | Notes are not turned on |
| **Waiting for speech** | On, nothing said yet |
| **On** | On, between updates. In automatic mode it counts down, for example "next update in 12 s" |
| **Taking notes** | A model call is running |
| **Waiting for you**, press Update now | Manual mode |
| **Paused** | Paused by you, at the limit, or by a plan limit |
| **Stopped** | Stopped by you, or after repeated failures |

The buttons follow the state. **Update now** (also `N`) is dimmed while a call runs. **Pause** and **Resume** pause and continue the notes. After **Stop notes for this meeting**, **Start notes again** starts them again. A button that can't do anything right now isn't shown. A command with no meeting running says so instead of doing nothing.

### Model, detail and language

In **Settings > Live Notes and Brief**, or **Model, detail and limit** in the panel menu:

| Setting | Choices |
|---------|---------|
| **Model** | **Automatic**, which names the model it will use, or any provider, model and effort you pick |
| **Updates** | **Automatic** or **Manual** |
| **Detail** | **Brief**, **Standard** or **Detailed** |
| **Language of the notes** | **The meeting's language**, or one of 12 languages |
| **Limit per meeting** | 30k, 60k, 120k, 240k or 500k tokens |

**Automatic** works like this, and it is worked out again before every run, so a provider you switch to, or a model list that arrives later, applies to the next run (not to one already running). With a subscription (Claude, Codex or Antigravity) it uses the CLI's fast tier. With OpenAI, Anthropic, Gemini or Groq it takes the first small model from a short list (a nano, mini, Haiku, Flash or Llama 8B model, for example) that your provider's own model list contains. That list is fetched in the background, at most once a day, with your key, and never during a live answer. Until it arrives, or when nothing on the short list is offered, it uses your active model and says so ("active model"). With OpenRouter it uses the prices OpenRouter lists: among text chat models with at least 32k tokens of room, skipping free ones unless your active model is free, it takes the lowest-priced model of the short list, where reading counts four times as much as writing. With Ollama, LM Studio or a custom server it always uses your active model, so it is not cheaper there. The label says **(cheapest)** only when the pick is the first model of the short list (or, on OpenRouter, nothing eligible costs less), and **(small model)** otherwise. To use a particular model, pick it yourself. The brief, memory suggestions and AI recaps follow the same rule.

If your Automatic model moves from Ollama or LM Studio (a model on your PC) to an online provider, for example because you switched provider in Settings, a line says **Notes now use (provider) (online).** with **Dismiss**, so you know the transcript now leaves your PC. The brief says the same. It shows once per move, until you dismiss it.

If the model can't answer (no key, plan limit, server not running), NexQ doesn't switch to another one. A plan limit shows **Notes paused** with the reason and **Try again**. Three failures in a row show **Notes stopped** with the reason. Both offer **Change model**, and **Try again** or **Start notes again**. NexQ can also read notes from a small local model that answers in plain lines instead of structured output, and it drops anything it can't read.

### Cost and the limit

Notes use your provider's tokens, so they cost what your provider charges for them. NexQ keeps each request small: it sends the new lines of the transcript and a short outline of the notes so far, not the whole meeting again. It counts the tokens the provider reports as new input plus the output (or an estimate when the provider doesn't say). The footer shows it, for example **12k of 120k tokens**.

The default limit is **120k tokens** per meeting. When the notes reach it, they pause and the panel asks:

> **Keep taking notes?** The notes used 120k tokens, the limit you set. Keep going adds 120k more.

Choose **Keep going** to continue (it adds the same amount again) or **Stop** to keep the notes you have. Nothing more is sent until you choose. Pick a smaller limit under **Limit per meeting** if you want a tighter ceiling. A new limit applies at once: raising it above what was used lets notes that stopped at the limit go on, and lowering it below stops them.

With a Claude, Codex or Antigravity subscription, the notes use your plan rather than money, and a plan limit pauses them with the reason.

### Keep and export

Notes are saved as you go, with the meeting. Open a past meeting and use the **Notes** tab: it shows the same page, editable, with **Copy as Markdown** and **Save as file** (a `.md` file). In the live panel, **Copy all as Markdown** is in the **...** menu.

### What notes see

Live notes read **only the transcript**: the new lines with their time and speaker, and the notes so far. They never read your documents, folders, tools, memory or talking points, and they don't use the workspace at all. The transcript goes to the model you chose for notes. A local model keeps it on your PC.

## The brief

### Turn it on

The brief is turned on **per workspace**, and that is its only switch. In the **Brief** panel, click **Turn on the brief**. Before you do, the panel says which model it will use. From then on it starts in every meeting of that workspace. **Turn the brief off** in the panel's **...** menu turns it off for the workspace. The brief is off in a workspace until you do this. It is not an on and off switch in Settings: **Settings > Live Notes and Brief** only holds its model and limit.

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

**Pause** and **Resume** pause and continue it, and **Refresh** makes a new sheet now (dimmed while one is being made). If it stopped, **Start the brief again** starts it. A button that can't do anything right now isn't shown. The state is said in words: **Off**, **Waiting for speech**, **On** (with "next update in 12 s" between calls), **Checking the workspace** (a call is running), **Paused** or **Stopped**. While there is no sheet yet, the panel says **Listening for the topic**.

### Model and the limit

**Model and limit** in the panel's **...** menu, or **Settings > Live Notes and Brief**, set the model (**Automatic** names the model it uses, by the [same rule as the notes](#model-detail-and-language)) and the **Limit per meeting**: 30k, 60k, 120k (the default) or 240k tokens. A new limit applies at once. A brief uses roughly 60k tokens an hour of conversation, so the default covers about two hours.

When the limit is reached, the brief pauses and asks **Keep the brief going?** with **Keep going** (adds the same amount) or **Stop**. If the model fails it says **The brief stopped** or **The brief paused** with the reason, and offers **Change model** and, when it can, **Try again**. It never switches to another provider on its own.

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

- **Start with Automatic and Standard.** With a subscription that is the fast tier. With the main API providers it is a small model once your provider's list is known, and with local servers it is your active model. The panel names the model before you turn anything on, so you can see what it will cost.
- **Use a local model for notes** if you don't want the conversation to leave your PC. It can be slower on a long meeting.
- **Turn the brief on in the workspaces that have a lot of material**, such as a client you have talked to many times.
- **Press N before the end** if you want the notes right up to the last minute. In automatic mode a final update runs anyway when you end the meeting. In manual mode it doesn't.

## Next Steps

- [Meeting window layout](meeting-layout.md): put the panels where you want them
- [Workspaces](workspaces.md): what the brief searches
- [Workspace chat](workspace-chat.md): ask questions after the meeting
- [AI Providers Guide](ai-providers.md): choose the model for notes and the brief
