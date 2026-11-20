# Using Your Claude Subscription (Beta)

NexQ can use your own Claude subscription (Pro or Max) as its AI provider, with no API key. NexQ launches the official `claude` command-line tool installed on your PC and talks to it locally.

> **Beta.** Uses your own Claude login on this PC. NexQ never sees your credentials.

## Setup

1. **Install Claude Code.** Follow the official instructions at [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup). NexQ finds the `claude` command automatically once it is installed.
2. **Log in, in your own terminal.** Open a terminal, run `claude`, and sign in with your Claude account when prompted (`/login`). You only need to do this once.
3. **Choose Claude in NexQ.** Open Settings (`Ctrl+,`) > LLM > **Subscription (local CLI)** > **Claude**, then click **Check connection**. A green dot shows the detected path, version, and the account you are signed in with.

If NexQ reports that you are not logged in, click **Open terminal to log in**. This opens a normal terminal window running `claude`. You sign in there, not inside NexQ.

## Fast and Deep models

You choose a model and an effort level for two kinds of work:

| Tier | Used for | Default |
|------|----------|---------|
| **Fast** | Live meeting answers: Assist, What to Say, Shorten, Follow-Up, Ask | Haiku · Low |
| **Deep** | Recap and past-meeting work: summaries, action items, Ask this meeting | Sonnet · Medium |

Haiku is the quickest and lightest on your usage limits. Sonnet reasons more carefully. You can pick any available model (Haiku, Sonnet, Opus, Fable) and a higher effort level for either tier, at the cost of slower answers and more usage. Changes apply to the next session; a running session shows "applies to next session".

Each tier also has an **Extended thinking** switch. With thinking off (the default for Fast), Claude answers right away: the first words usually arrive in under a second. With thinking on (the default for Deep), it reasons before answering, which helps with harder requests but takes longer and uses more of your limits.

## Choosing what the AI looks at

The **context chip** next to the action buttons in the meeting view sets which part of the transcript an action works on: the action's own default, everything since the last answer, since the last answer of the same action, the last 2, 5, 10 or 15 minutes (or a custom number), or the whole meeting. Turn on **Keep for next actions** to keep your choice; otherwise it goes back to the default after one action. A Claude session already holds the whole meeting, so each request only sends the transcript that is new since the previous one, plus a note about the scope you picked.

## Asking about something on screen

When the thing you need help with is only visible on screen (an exercise, a question in a chat or slide, a diagram), send a picture of it instead of retyping it:

1. Copy a screenshot of just the part you need, for example with `Win+Shift+S`.
2. Open **Ask** in the meeting view.
3. Press `Ctrl+V` in the Ask box. The picture shows as a small thumbnail.
4. Press Enter.

**Or capture the screen with one key.** During a meeting, press `Ctrl+Shift+S` from any app. NexQ takes a picture of the screen your mouse pointer is on (so it works with the meeting on a second monitor), brings the overlay up, opens the Ask box, attaches the picture and puts the cursor in the Ask box; press Enter to send. Nothing is sent until you do. Windows only for now. Change the key in Settings > General.

- The capture shortcut is on only during a meeting with **Claude (subscription)**. With another provider `Ctrl+Shift+S` stays free for your other apps, and Settings says why the shortcut is off.
- NexQ's own windows are not hidden or moved for the picture. With **Hide from screen share** on, they are left out of it; otherwise they are in it like any other window. If the overlay was hidden, it comes back once the picture is taken, so it isn't in it.
- If the capture fails (for example the screen is locked or shows protected video), a short message says so.
- You can attach up to 3 images (PNG, JPEG, GIF or WebP). NexQ shrinks large ones before sending, so a full-screen screenshot works. Click the **x** on a thumbnail to remove it.
- With an empty box, the image itself is the question: Claude reads it and answers or solves it, rather than describing it.
- This works only with **Claude (subscription)**. With another provider, NexQ doesn't attach the image and tells you images need Claude. When Claude is unavailable and NexQ would answer with the fallback provider, it asks you to try again or remove the image, instead of answering without it.
- If the send fails, your text and images stay in the Ask box so you can send again.
- Images are not replayed if NexQ has to restart the Claude session; only the text is.

## How sessions work

NexQ keeps a Claude session open and sends it only what is new, so answers stay fast and you do not pay to re-send the whole meeting every time.

- **Live meeting.** When you start a meeting, NexQ starts a Fast session in the background. It holds your scenario prompt, custom instructions, and your context documents (up to roughly 100,000 tokens; beyond that, NexQ falls back to normal document search for each question). Each time you use an AI action, NexQ sends only the transcript since your previous request plus the question. The footer shows "Session ready" when it is warmed up. Recap uses a separate Deep session, started the first time you use it. Sessions close when the meeting ends.
- **Past meeting.** Opening a past meeting starts a Deep session preloaded with the transcript (speakers and timestamps) and the summary if there is one. Context documents are not included. The session closes when you leave the meeting or after 15 minutes of inactivity. Reopening restarts it quickly.
- **Ask this meeting.** In a past meeting, the **Ask** tab lets you chat with the meeting. Questions and answers are saved with the meeting, restored when you reopen it, and listed in the AI Log, so follow-up questions keep their context.
- **Other uses.** Things that are not tied to a meeting (such as LLM translation and testing your knowledge base) use their own small Fast session, so they never mix into a meeting.

Some per-action options do not apply in Claude mode (transcript window, temperature, web search), because the session already holds the whole meeting. They appear disabled with "Not used with Claude CLI" in the AI Actions settings.

## If Claude is unavailable

If Claude cannot answer (not installed, logged out, rate limited, or it keeps crashing), NexQ switches to your **fallback provider** and shows a toast such as "Claude unavailable (not logged in) — using Groq". Pick the fallback provider in the same settings group; by default it is the last API or Ollama provider you used, or none. While Claude is unavailable, NexQ checks it again every minute and switches back when it is healthy. After a rate or usage limit it waits about 15 minutes before checking again.

## Usage indicator

Hovering the Claude chip in the footer shows the models, the number of requests in this meeting, when the last one ran and how long it took, the average response time and time to first words, the tokens in (including cached input) and out (including thinking), and the cost reported by Claude. The AI Log header shows the same totals, and each log entry shows the actual tokens and cost of that request. Treat this as an **estimate**: with a subscription login it is included in your plan, and Claude does not expose your real remaining quota, so NexQ cannot show it. If Claude reports a rate or usage limit, NexQ warns you and uses the fallback provider.

## Personal sources

Let the AI look things up in your own notes and tools while it answers you. Open **Settings > Personal Sources**, or use the Personal sources section on the launcher's main screen. Both are the same list. Personal sources work only with **Claude (subscription)**; with another provider they stay saved and are not used.

- **Notes folders.** Add a folder of `.md` files, such as an Obsidian vault. The AI can search and read it but never change it. A folder that holds your whole user folder, your Claude sign-in files or NexQ's own private files is refused.
- **Tools (MCP servers).** Choose **Add server**, paste the `mcpServers` JSON from the server's README (or fill in a form, or import a server from Claude Code). NexQ checks the new server right away and shows its tools, so you can look before switching it on. Each tool has its own switch; tools whose names suggest they change something (add, send, edit, delete) start off.
- **Per answer.** In a meeting and in past-meeting chat, the **Notes** and **Tools** pills decide whether the answer you ask for may use them. Automatic answers (detected questions, summaries, action items) never use your sources. Looking things up can add a few seconds.
- **Links in answers.** A link in an answer never opens by itself. Clicking it shows the full address and opens your browser only after you confirm.

### If a server's Check fails

The card shows why, plus the server's own last message when it has one.

| What you see | What it means and what to do |
|---|---|
| "It couldn't start npx: ..." | The command isn't installed or not found. Servers written as `npx ...` need [Node.js](https://nodejs.org/); `uvx ...` needs [uv](https://docs.astral.sh/uv/). Install it, open a new NexQ so it sees the updated PATH, and Check again. |
| "The server failed to start" and "It stopped right away (exit code N). Its last message: ..." | The server started and quit. Read the message: usually a missing or wrong key, a wrong path or a wrong argument. Edit the server (the pencil on its card) and Check again. |
| "The server didn't answer in time" | The first run of an `npx` or `uvx` server downloads it, which can take close to a minute. A Check waits up to 60 seconds; try Check again once the download has finished. Meeting answers wait only 20 seconds, so Check a new server once before relying on it. |
| "The server answered 401 Unauthorized" (or 403) on a URL server | The address or the header value (for example a token) is wrong or expired. |
| "Needs sign-in, not supported yet" | The server wants an OAuth sign-in in a browser. NexQ doesn't support that yet; only servers that take a key or token in a header or variable work. |

On Windows, write the server exactly as its README does, for example `{"command":"npx","args":["-y","some-package"]}`: the Claude tool that NexQ runs finds `npx` itself, and so does NexQ's check. `{"command":"cmd","args":["/c","npx","-y","some-package"]}` works too. Secret values (keys, tokens) are kept in the Windows credential store, not in NexQ's settings file.

## Privacy

- NexQ never reads your `~/.claude` folder, your credentials, or any tokens. Sign-in happens only in Claude's own tool.
- NexQ runs the unmodified `claude` program with all tools disabled, in an empty private folder. Claude cannot read your files, run commands, or browse on NexQ's behalf. The one exception is the notes folders and tool servers you add under [Personal sources](#personal-sources): a session that may use them can read those folders and call the tools you switched on, nothing else. What it reads there goes to Anthropic like the transcript does.
- Claude API environment variables (such as `ANTHROPIC_API_KEY`) are removed from the process, so NexQ never passes an API key to Claude. The session uses whatever account you logged in with: if that login bills an API account rather than a Pro or Max plan, Settings and the footer show "This Claude login bills an API account, not your subscription." (amber, never "Connected"). It still works, at API prices; log in with your Claude account to use your subscription instead.
- Images you paste or capture into Ask go to Anthropic with your question, like the transcript. A screenshot can include other people's video or documents. NexQ doesn't save them; the AI Log keeps only the text.
- Transcript and context text you send is processed by Anthropic under your Claude account's terms, like any Claude conversation. Choose a local provider (Ollama, local Whisper) if audio and text must stay on your machine.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Claude not found" | Install Claude Code ([setup guide](https://code.claude.com/docs/en/setup)), then click **Check connection**. |
| "Found an npm install of Claude Code" | NexQ needs the native installer (`claude.exe`), not the npm package. Install it from the [setup guide](https://code.claude.com/docs/en/setup). |
| "Bills an API account" | Your Claude login is an API (Console) login. Run `claude`, then `/login` with your Claude account. |
| "Not logged in" | Click **Open terminal to log in**, sign in, then check again. |
| Slow first answer | The first answer in a session is slower while it warms up; later answers are faster. |
| Rate or usage limit | Wait for your limit to reset, or use the fallback provider. |

See also: [Choosing AI Providers](ai-providers.md), [Configuration Guide](configuration.md), [Troubleshooting](troubleshooting.md).
