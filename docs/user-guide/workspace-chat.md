# Workspace Chat

Workspace chat lets you ask questions across everything in a workspace: its past meetings, its documents, the folders you allowed and its notes. "What did we decide about pricing?" "What did I promise Priya?" "Summarize last week's calls." Each answer says where it came from.

It lives in the middle of the [workspace](workspaces.md) screen. It only uses the workspace you have open (and General, if you turned on **Also use General** for it). It never uses the meetings of another workspace.

## Prerequisites

- An LLM provider set up ([AI Providers Guide](ai-providers.md))
- Some material in the workspace: a few meetings, or documents in the Library

## Ask a question

1. Open a workspace.
2. Type in the box. The placeholder reads **Ask about your meetings, documents and notes**. Under **Try asking** you may see up to three questions made from your own meetings and memory. Click one to use it.
3. Press `Enter`, or click **Ask**. `Shift+Enter` adds a line.
4. The answer streams in. **Stop** cancels it. What was written stays on screen as **Stopped. What was written is kept here, not saved.**, with **Ask again** and **Dismiss**.

While it works, the line under the answer says what it is doing: the tool it is using (for example "Notes: set_flag", shortened to one line and never showing a private file path), **Reading 5 items**, **Writing**, or **Starting**.

Before you send, the box shows how much the question would carry, for example **About 6.2k tokens of 24k**. Your chat is saved as you go. Only questions that got an answer are kept.

Chats are listed under **Chats**. **New chat** starts another, you can rename a chat by clicking its name, and the list has search and delete. Deleting a chat deletes its answers and can't be undone.

## What shapes an answer

Under the box you can change:

| Control | What it does |
|---------|--------------|
| **Model** | Which provider and model answers. Each chat has its own. A new chat uses the model you set in Settings. With a subscription (Claude, Codex or Antigravity) it starts on your **Deep** model |
| **Effort** | How hard the model thinks, for models that have it |
| **Depth** | **Lean**: quick and cheap, about 8k tokens of your material. **Balanced**: for most questions, up to 24k tokens, and it stops when nothing more is relevant. **Deep**: searches widely, up to 80k tokens, slower and costs more. Those are the sizes with an API provider. With a subscription or a local model, which cost nothing per token, the room grows with the model: Lean 16k, Balanced up to 64k, Deep up to 150k |
| **All meetings** | Which past meetings the chat may use. Turn **Use past meetings** off, or untick single meetings. **Use all again** brings them back |

In a chat that already has messages, depth, effort and meetings sit behind one button that shows what is set, for example **Balanced, All meetings**.

These limits come from the model: an answer never uses more than 60 percent of the model's window. If NexQ can't tell a model's window, it assumes 128k tokens (200k for Claude, Codex and Antigravity). A model with a window under 8k tokens gets a notice that answers will see less.

## How it finds things

You can have years of meetings in a workspace, and the answer stays quick, because NexQ doesn't send everything. It searches first and sends only what fits.

**The index.** NexQ keeps a search index of the workspace on your PC. It holds:

- Meeting transcripts, cut into short passages at speaker changes, each with its time
- Your documents
- The folders in the workspace's Library
- Talking points that are marked **Use as AI context**

It builds the index in the background at low priority, pauses while a meeting runs, and updates it when text changes. Old meetings are indexed newest first. Building it uploads nothing, and it uses keyword search only: no embedding model is needed. (The one exception is **Prepare recaps with AI**, if you turned it on: that sends a meeting's transcript to a model.)

**The search.** Passages are ranked by how well they match your question. Recent meetings get a small boost that fades over a couple of months. No more than three passages come from the same source, so one long file doesn't crowd out the rest, and weak matches are dropped.

**What an answer carries.** NexQ fills the room it has, in this order:

1. The workspace's instructions, the saved memory (at most 1,500 tokens) and the documents you pinned (at most a quarter of the room)
2. Everything you included, when all of it fits. The context panel then says **Everything included fit.**
3. Otherwise, a short recap of each meeting (the 10 newest, then the most relevant), the passages found for your question, and the recent conversation. The panel says **Picked the most relevant material.**

A meeting's recap is its saved summary when it has one. Otherwise it is a short extract that NexQ makes on your PC (no AI call), or, only when the workspace has **Prepare recaps with AI** on, a short recap written by a model from that meeting's transcript ([how and when](workspaces.md#recaps-with-ai)).

**The conversation.** The last 8 turns are sent as written. When older ones pass a quarter of the room, the chat's model condenses them, which costs one call. You see **Earlier messages condensed**, and **Show N originals** brings the originals back on screen. Nothing is deleted.

**When something didn't fit,** the answer says so, for example **3 things didn't fit.** Click **Search deeper** to ask again with the **Deep** depth.

**While NexQ is still indexing,** a note says so beside the box and with the answer, for example **Still indexing: 40 of 300 meetings are searchable, so older meetings may be missing from this answer.** The Library shows **Still indexing 312 of 540**. Results may leave out files that aren't indexed yet.

### See what it saw

**Context** above the box is a strip of bars. Click it to open it. Each bar is one item, its width is its size in tokens and its height is how relevant it is. The layers are **Instructions and memory**, **Meetings**, **Documents**, **Folders** and **Conversation**. Click a layer to see its items. For each one you can **Open** it, **Pin** it, or **Leave out of this chat** (and **Use in this chat** to undo). The panel is titled **What the next answer will see** before you ask and **What the last answer saw** afterwards.

The same strip, for the workspace as a whole, is at the bottom of the Library.

## Citations

Sources appear as `[S1]`, `[S2]` tags in the answer. Click one, or open **N sources** under the answer, to see each source with its kind (**Meeting**, **Document**, **Folder file** or **Talking point**), its title, the moment in the meeting (for example "Weekly sync at 12:41") and a short snippet.

- A meeting opens on its **Transcript** at the line that was being spoken at that moment (the nearest line that started at or before it), and the line is marked for a moment. A source with no time opens the meeting at the top.
- A document opens the Library and marks its row.
- A file in a folder opens a small box with its path and **Open folder**, which shows the file in your file manager (names with spaces, commas or accents work).
- A talking point opens its editor.

A tag can only point at something that was really sent to the model. NexQ removes any tag the model invents. Text from your meetings and files is handed to the model as data, and the model is told not to follow instructions that appear inside it.

An item that has no usable name is shown as **Removed item**, never as a code.

Opening an item from the context panel (**Open**) works the same way, and a meeting opens at its moment there too.

## Keep an answer

Under each answer:

- **Copy** copies the answer without its source tags
- **Ask another model** asks the same question again with a model you pick
- **Save to library** shows the answer in a box you can edit and saves it as a document in this workspace, so later answers can use it. It is kept as it is: code, links and HTML stay, and only hidden characters are removed (up to 100,000 characters). If anything had to be removed, the box is cleaned first, says how many hidden characters went, and nothing is saved until you read it and click **Save** again
- **Add to instructions** shows the answer in a box you can edit (up to 4,000 characters) as plain text. Links, images, HTML and hidden characters are not kept. If anything had to be removed, the box is cleaned and says what, for example "Removed: 2 HTML tags, the link address https://...", and nothing is added until you read it and click **Add to instructions** again. NexQ adds exactly the text in the box after your instructions, separated by a line, and the dialog offers **Undo**, which puts the instructions back as they were. Think before you confirm: the AI follows instructions in every later answer

Both **Save to library** and **Add to instructions** are refused with "This answer used material that is no longer part of this workspace, so it can't be saved. Ask again." when something the answer used has left the workspace.

## When something an answer used leaves the workspace

The workspace's scope can change while an answer is being written or after it: you move a meeting to another workspace, delete it, take a file or folder out, forget a memory item, turn off **Also use General**, or leave a meeting out of the chat. NexQ checks this against the database, so it doesn't matter which window made the change.

- **A running answer stops.** It shows "Something this answer used was moved out of this workspace, so it was stopped." with **Ask again** and **Dismiss**. Its text, its sources and its tool cards are dropped, and only your question stays.
- **A saved answer that rests on that material is not sent to the model again** as part of the conversation, and it can't be saved to the library or added to the instructions. The answer stays on screen, and its source shows as removed.
- **Condensed summaries** of the chat that may quote the material are dropped.

If NexQ can't read what a chat may use, it treats everything as not allowed.

## Providers

Chat can use any provider you have set up. It doesn't use the one that answers live questions, so a chat can use Codex while the meeting runs on Claude. If the provider fails, NexQ shows what failed and gives you **Open provider settings**, **Pick another model** and **Try again**. It never switches to another provider on its own.

| Provider | Finds | Tools |
|----------|-------|-------|
| Ollama, LM Studio, a custom server, OpenAI, Anthropic, Gemini, Groq, OpenRouter | Passages NexQ found | None. If the workspace has tools (MCP servers), the box says the model can't use them |
| Claude (subscription) | Passages, plus it can open files in the workspace's folders and meeting files | Read-only tools run. Tools that could change something ask you first (see below) |
| Codex and Antigravity (subscriptions) | Passages, plus the same folders and meeting files, read through NexQ's own read-only notes tool | Tools that could change something are off, and the box says so. Read-only tools still run |

With a subscription, a chat can open files in the folders of the workspace through Personal Sources. It can also read the meetings you included, which NexQ writes as plain text files into a private folder for that chat. Only that chat can read the folder. It is deleted when the chat session closes and when NexQ starts. Claude's file tools are limited to those folders, and shell, file-editing and web tools never run in a chat.

While a meeting is running, workspace chat still works, but answers take turns one at a time so live answers stay fast. If a live answer needs the local server (Ollama, LM Studio or a local custom server) that a chat is using, the chat answer is stopped with **A live answer took priority**. Click **Try again** when the meeting is quiet.

## Tool approval

Asking works with Claude (subscription), version 2.1.328 or newer. With an older Claude, or when NexQ can't read its version, the tools that would ask are switched off, and the line under the box lists them with the reason, for example "can't ask before a tool runs; update to 2.1.328 or newer".

A tool runs without asking only when all of these are true:

- You allowed it in **Settings > Personal Sources**
- Its server marks it as read-only
- Its name doesn't sound like it changes things (add, send, edit, delete)
- It isn't marked destructive

Anything else asks. A card shows **The model wants to run** the tool on a server, with the exact arguments (**Show arguments**). You choose:

- **Allow once**, which runs that one call
- **Deny**

If you don't answer, the call is denied after **60 seconds** (the card says "No answer in 60 seconds, so it was denied."). There is no "always allow". A card belongs to the answer that asked: if no answer is being written when a tool asks (for example a stopped answer), the call is refused and nothing is asked. A refused call is named with the answer, for example "CRM: send_mail was not run: ..." with the reason. If the tool is switched off, the reason says so ("send_mail is turned off for this server. Turn it on in Settings > Personal Sources.") and **Open Personal Sources** next to it takes you there. Tools whose names suggest they change something start switched off. Values under names like `password` or `api_key` are hidden, and hidden characters are shown as `\u{...}`. If arguments were cut or hidden, the card says so, and **Deny** is the highlighted button.

## What leaves your PC

- **Searching and indexing happen on your PC.** Adding a file, building the index and finding passages send nothing anywhere. The one exception is **Prepare recaps with AI**, if you turned it on for the workspace: it sends one meeting's transcript at a time to a model ([Workspaces](workspaces.md#recaps-with-ai)).
- **When you ask,** NexQ sends the provider you chose for that chat: your question, the workspace instructions, saved memory, the passages, recaps or files picked for this answer, and the recent conversation (once a conversation is long, its older turns also go to the same model to be condensed). With Ollama or LM Studio on your PC, that stays on your PC. With a cloud provider, it goes to that provider. With a **Custom server**, it goes wherever that server runs.
- **With a subscription,** the CLI also sends what it reads itself to its provider: files from the workspace's folders, meeting files, and the results of tools you allowed.
- **Folders you removed from the Library** are not searched. See [Workspaces](workspaces.md#folder-text-search).
- **Other workspaces** are never included: not their meetings, not their chats. Anything you left out of a chat stays out.
- **Your chats** are stored in NexQ's database on your PC, with the sources and token counts of each answer. Deleting a chat or its workspace removes them.

## Tips

- **Ask about one thing at a time.** A narrow question finds better passages than a broad one.
- **Use Lean for quick lookups** and **Deep** for questions like "what changed over the last month?".
- **Pin the one document that matters** (a brief, a contract) so it is always in front of the model.
- **Check the sources.** If an answer is wrong, the source list shows what the model saw.

## Next Steps

- [Workspaces](workspaces.md): what a workspace holds and shares
- [Live notes and the brief](live-notes-and-brief.md): help during the call itself
- [AI Providers Guide](ai-providers.md): choosing a provider for chat
- [Claude subscription](claude-subscription.md#personal-sources): notes folders and tools
