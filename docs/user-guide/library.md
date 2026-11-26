# The Library: Documents, Notes, Folders and Tools

The Library is the list of what the AI may use in a workspace: documents and notes you add, folders of notes it can search, and tools (MCP servers) it can call. In a meeting, two pills, **Knowledge** and **Tools**, let you decide per answer whether it may use them.

## Prerequisites

- NexQ installed and running ([Getting Started](getting-started.md))
- A [workspace](workspaces.md). You already have **General**
- For tools: a Claude, Codex or Antigravity subscription ([Claude subscription](claude-subscription.md))

## The Library panel

Open a workspace. The **Library** is the first part of the panel on the right. In a narrower window, click **Library** at the top or press `Ctrl+Shift+Y`. Each row shows the name you gave it, what kind it is (**Document**, **Note**, **Folder** or **Tool**) and its state in words:

| What you see | What it means |
|--------------|---------------|
| **Ready**, with a token count | A document NexQ has read |
| **Reading its text** or **Indexing** | NexQ is still working on it |
| **Indexed · 638 files** | A folder NexQ has read, with the number of files |
| **Indexing 120 of 638** | NexQ is reading the folder now |
| **Updated just now** | A file in the folder changed and NexQ read it again |
| **Missing** | The file or folder moved or was deleted. Click **Remove**, or put it back |
| **Off in Settings** | You switched it off in **Settings > Personal Sources** |

## Add documents and notes

1. Click **Add** at the top of the Library, or **Choose files** under the list. You can also drop files on the window.
2. NexQ reads PDF, text, Markdown and Word files.
3. To save something you typed, choose **Paste text**. It is saved as a Markdown document, shown as a **Note**.

A file you add here belongs to this workspace. The file on your disk is never changed.

## Add a folder

1. Choose **Add > Folder** and pick a folder, for example a notes vault.
2. NexQ reads it and keeps it up to date by itself. It never changes your files.

NexQ reads `.md`, `.txt`, `.pdf` and `.docx` files. It skips hidden and system folders, `node_modules`, links, files over 2 MB, anything past 5,000 files in one folder, and files that look like secrets (names starting with `.env` or `id_`, ending in `.pem` or `.key`, or containing `credential`, `secret`, `token` or `password`). A folder with skipped files shows **N files skipped**. Click it to see each file and the reason.

A file you add, edit, rename or delete is read again a couple of seconds after it stops changing. Every 30 minutes NexQ also checks the whole folder once, in case it missed a change. If something looks wrong, open the row's **...** menu and choose **Re-index now**. Indexing waits while a meeting is running.

To stop using a folder, remove it from the Library.

## Add a tool

1. Choose **Add > Tool (MCP server)**.
2. Paste the `mcpServers` JSON from the server's README, or follow the form.
3. NexQ checks the server and lists its tools. Each tool has its own switch in **Settings > Personal Sources**, and tools whose names suggest they change something (add, send, edit, delete) start off. Use **Manage in Settings** on a row to get there.

Tools work with a Claude, Codex or Antigravity subscription. Secret values such as keys and tokens are kept in the system credential store, not in NexQ's settings file.

## Use something in another workspace

Everything exists once in the library, and workspaces point to it. To use a file, folder or tool in another workspace, choose **Add > Files, folders and tools in the library**, tick what you want and click **Add**. Nothing is copied.

## What you can do with a row

- **Rename it.** Click the name. Your name is only a label.
- **Pin a document.** A pinned document is offered to every [workspace chat](workspace-chat.md) answer first, up to a quarter of what one answer can hold.
- **Remove from this workspace.** The library keeps it, and other workspaces keep using it.
- **Remove from library** (documents). It leaves every workspace that uses it and its index is removed. The file on your disk is not touched.
- **Index again** (documents, when the local knowledge base is on).

## The Knowledge and Tools pills

In the meeting assistant, next to the action buttons, two pills show what your next answer may use of the meeting's workspace.

- **Knowledge** is the workspace's documents, notes and folders. It works with every provider. With a subscription (Claude, Codex or Antigravity) the answer can read the files in your folders itself. With an API or a local provider, NexQ searches the folders and sends the best matching passages with your question.
- **Tools** are the workspace's tool servers. They need a subscription. With another provider the pill is shown but locked, and its hover card says so.

A pill is **on** or **off**. **Knowledge** starts on in every meeting. **Tools** start off until you turn them on. A pill that is off keeps everything of its kind out of the answer. Hover a pill to see what it covers, for example "3 documents, 1 note, 1 folder (Acme notes)". A pill only shows when the workspace holds something of its kind. If the session that reads sources fails, the pill shows an error with **Retry**.

The pills follow the meeting's workspace, so a meeting in one workspace never reaches another workspace's files unless you picked **Also use** for it. The same pills are in the **Ask** tab of a past meeting.

Automatic answers, such as summaries and action items, never use your folders or tools. Looking things up can add a few seconds to an answer.

## Privacy

- Adding a file and indexing a folder send nothing anywhere. NexQ searches on your PC.
- When an answer uses your material, it goes to the provider that answers: the passages that matched, or, with a subscription, whatever the CLI reads itself. With Ollama or LM Studio on your PC it stays on your PC.
- Tool results go to your AI provider as part of the answer. Add only tools you are happy to share with it.
- In a workspace chat, a tool that could change something asks before it runs ([Tool approval](workspace-chat.md#tool-approval)). There is no "always allow".
- Other workspaces' files are never included. A workspace set to **Keep separate** cannot be borrowed and borrows nothing ([Workspaces](workspaces.md#keep-separate)).

## Tips

- **Name your files.** A name like "Pricing 2026" helps you read the Library and the sources of an answer.
- **Add a folder instead of copying notes in.** It stays up to date on its own.
- **Turn Knowledge off** for an answer that should come from the call alone.

## Next Steps

- [Workspaces](workspaces.md): what a workspace holds and shares
- [Using Context Intelligence](rag-context.md): the local knowledge base for documents
- [Claude subscription](claude-subscription.md#personal-sources): notes folders and tools in detail
- [Workspace chat](workspace-chat.md): ask across the Library and your meetings
