# Workspaces

A workspace is a named place for the meetings, chats and files of one job, client or course. Each one keeps its own meetings and chats. What the AI can read in a meeting or a chat depends on the workspace it belongs to, so a client's documents don't show up in another client's answers.

## Prerequisites

- NexQ installed and running ([Getting Started](getting-started.md))
- Nothing else. You already have one workspace, called **General**

## The main screen

The launcher opens on your workspaces. It has three parts:

- **The list on the left.** Your workspaces, then the meetings of the one that is open, with a search box that looks **Here** or **Everywhere**. Each workspace has a small waveform mark in its own colour, so you can tell them apart at a glance.
- **The middle.** The name of the open workspace, one bar for each of its meetings (taller means a longer meeting; click a bar to open it; the 60 newest are single bars, and older ones are gathered into one bar a month, named like "12 earlier meetings"), the **Start meeting** button, and the [workspace chat](workspace-chat.md).
- **The Library on the right.** The documents, folders and tools this workspace uses, its instructions, its [talking points](talking-points.md) and its memory.

How much you see depends on the width of the window:

| Width | What you get |
|-------|--------------|
| 1100 px or more | All three parts side by side |
| 820 to 1099 px | The Library slides in when you click **Library** (or press `Ctrl+Shift+Y`) |
| Under 820 px | The list shrinks to the marks only. Hover a mark to see the name |

The launcher opens at 1180 by 740 pixels, or 92 percent of your screen if that is smaller. It remembers its size and place, and the meeting window does the same.

## General

**General** always exists. It can't be deleted or archived. Before you make another workspace, everything you have is in it.

## Create a workspace

1. Click **+** next to **Workspaces** in the list, or press `Ctrl+Shift+N`. **New workspace** on the **All workspaces** page does the same.
2. Fill in the form:

| Field | What it does |
|-------|--------------|
| **Name** | Up to 60 characters. Two workspaces can't have the same name |
| **Colour** | Colours its mark. It is only to tell workspaces apart |
| **What is it for** | One optional line (160 characters) shown under the name |
| **Instructions for the AI** | How to work here: who the people are, what to focus on, the tone. Read in every meeting and chat of this workspace, after your general instructions |
| **Starts as** | The scenario meetings use when you start them here. Leave it on **No preset, use my usual** to use your usual one |
| **Also use General** | Lets this workspace use General's files and tools as well. Off for a new workspace. The line under it says how many files and tools General has |
| **Keep separate** | Cuts this workspace off from all others (see [What is shared](#what-is-shared-between-workspaces)) |
| **Make default** | Makes this the workspace that meetings start in when you didn't choose one |
| **Prepare recaps with AI** | Only when you edit an existing workspace. Off by default. See [Recaps](#recaps-with-ai) |

3. Click **Create workspace**. It opens right away.

To change any of this later, click **Edit workspace** at the top of the workspace, or open **Settings** from the **...** menu on its row.

### The row menu

Every workspace has a **...** menu in the list and on the **All workspaces** page:

- **Settings**
- **Pin to the top** or **Unpin**
- **Make default**
- **Clone**
- **Archive** or **Bring back**
- **Delete**

**See all** (above the list) opens **All workspaces**, a page with search, sorting (**My order**, **Name**, **Last activity**, **Most meetings**), **Move up** and **Move down** in **My order**, and a switch for archived workspaces.

Press `Ctrl+Shift+O` anywhere in the launcher, or click the workspace name at the top, to jump to another workspace by typing part of its name.

## The default workspace

One workspace is the default. It starts as General. Meetings go to it when you start them without picking a workspace:

- The `Ctrl+M` shortcut
- The tray icon menu
- The call detection prompt, unless you pick another workspace there
- **Start on Login** (Settings > General)

When you press **Start meeting** in the launcher, a setup dialog opens first. It suggests the workspace that is open. From top to bottom it has:

1. **Workspace**, and under it **Also use** (only when you have more than one workspace). With more than six workspaces, **Workspace** is a field you can search instead of a row of buttons
2. **Scenario**
3. **Audio mode**
4. **Record Audio**
5. **Remember these settings for next time**
6. **Start Meeting**

When you have remembered settings, the dialog opens compact: a line of badges (audio mode, the workspace, the scenario) and a **Start Meeting** button, with **Change settings** to open the full list. The workspace badge says **Change**; clicking it opens the full list. The call detection prompt has a workspace button for the same reason.

The scenario comes from the first of these that applies:

1. The one you picked for this meeting
2. The workspace's **Starts as**
3. Your usual one: the scenario you used last, or **Start as** in the call detection settings when a call starts from the detection prompt

Nothing changes the scenario of a meeting that is already running.

To change the default, choose **Make default** on another workspace. The default workspace can't be archived or deleted until another one takes its place.

## Meetings in no workspace

**A workspace that is gone.** If the workspace a meeting is asked to start in has been archived, deleted or can't be read, NexQ does not file the meeting somewhere else, because that would use material you didn't choose. The meeting starts **not filed in a workspace** and uses none of anyone's material. A notice says so, and the workspace button in the meeting window reads **No workspace**. Pick one from that button to file it. Until then it can't also use other workspaces.

**Not filed.** Meetings in no workspace are gathered under **Not filed**: a row in the list on the left (with their number), and a row on the **All workspaces** page. Both only appear when there is at least one. The page lists them, newest first, with a search box once there are more than five. **File in...** on a meeting moves it to a workspace you pick, and **File all in...** moves all of them to one workspace. Filing is the normal move, so it follows [the rules for moving a meeting](#move-a-meeting).

## What is in a workspace

The **Library** panel lists what the AI can use in this workspace. Each row shows the name you gave it, what kind it is (**Document**, **Folder** or **Tool**) and its state in words.

### Add documents

Click **Add** at the top of the Library, or use **Choose files** under the list. You can also drop files on the window. NexQ reads PDF, text, Markdown and Word files. A file you add here belongs to this workspace. **Paste text** saves what you paste as a Markdown document.

If you use the local knowledge base (see [Using Context Intelligence](rag-context.md)), new documents are indexed for it automatically.

### Add a folder

Choose **Add > Folder** and pick a folder, for example a notes vault. The AI reads it but never changes it. A folder is only searched by NexQ once you allow it (see [Folder text search](#folder-text-search)).

### Add a tool (MCP server)

Choose **Add > Tool (MCP server)** and follow the form. The server joins the library and this workspace together. Tool switches and secret values stay in **Settings > Personal Sources**. Use **Manage in Settings** on a row to get there.

### Reuse something you already added

Everything exists once in the **library**, and workspaces point to it. To use a file, folder or tool in another workspace, choose **Add > Files, folders and tools in the library**, tick what you want and click **Add**. Nothing is copied.

### What you can do with a row

- **Rename it.** Click the name. Your name is only a label; the file keeps its own. A folder or tool whose record is gone shows as **A folder that was removed** or **A tool that was removed**, never as a code.
- **Pin a document.** A pinned document is offered to every workspace chat answer first, up to a quarter of what one answer can hold.
- **Remove from this workspace.** The library keeps it, and other workspaces keep using it.
- **Remove from library** (documents). It leaves every workspace that uses it and its index is removed. The file on your disk is not touched.
- **Index again** (documents, when the local knowledge base is on).

The state in a row is one of these:

| What you see | What it means |
|--------------|---------------|
| **Ready**, with a token count | A document NexQ has read |
| **Reading its text** or **Indexing** | NexQ is still working on it |
| **Indexed** | A folder whose text can be searched |
| **Needs your OK to search its text** | A folder you haven't allowed yet |
| **Missing** | The file or folder moved or was deleted. Click **Remove**, or put it back |
| **Off in Settings** | You switched it off in Settings > Personal Sources |

### Folder text search

Under each folder is a switch, **Search its text**. It is off for every new folder and for every folder that existed before the upgrade. Turn it on to let workspace chat and the [brief](live-notes-and-brief.md) find passages in the folder. The passages that match a question go to the AI provider you use, so NexQ asks first.

When it is on, NexQ reads `.md`, `.txt`, `.pdf` and `.docx` files and skips:

- Hidden and system folders, and `node_modules`
- Files that look like secrets: names starting with `.env` or `id_`, ending in `.pem`, `.key` or similar, or containing `credential`, `secret`, `token` or `password`
- Files over 2 MB, and anything past 5,000 files in one folder
- Links and junctions, which are never followed

Skipped files are listed. A folder with skipped files shows **N files skipped** in its row. Click it to open **Skipped in (folder)**, with each file's path and the reason (too large, a name that looks like a secret, hidden, over the limit). Nothing is changed or removed. Skipped files that can't be matched to a folder are listed under the Library as **N files skipped**.

NexQ scans again every 10 minutes while a workspace is open. **Rescan folders** at the bottom of the Library does it now. Indexing waits while a meeting is running.

While the index is being built, the Library says **Still indexing 312 of 540**, and the chat box and the context estimate say that results may leave out files that aren't indexed yet.

This switch only controls NexQ's own search. With a subscription (Claude, Codex or Antigravity), a chat or a meeting can also read the files in the folders of the workspace itself (see [Personal sources](claude-subscription.md#personal-sources)), and that does not depend on this switch.

### Recaps with AI

By default a meeting's recap is its saved summary, or a short extract that NexQ makes on your PC. **Prepare recaps with AI** (in **Edit workspace**, off by default) lets NexQ write a short recap with a model for meetings that have no summary. **The transcript of that meeting is sent to the model.** The setting says which model.

When it runs:

- After each meeting in the workspace ends, for that meeting, a few seconds later once it is indexed
- When you open the workspace, for up to 5 meetings that don't have a recap yet, newest first, once per opening
- When you click **Try again** beside a recap failure, in **Edit workspace** or at the bottom of the Library. It runs the way opening the workspace does (never in a meeting) and says what came of it: **All recaps are written.**, **2 written, 1 still failed.** or **They failed again.**
- When you click **Rescan folders** in the Library (shown only when the workspace has a folder). This also lets recaps that failed try again

It never runs while a meeting is running. NexQ checks that the switch is still on, the workspace isn't archived and the meeting is still there before each call, and drops the result if anything changed while the model was working.

A recap is at most about 120 words. From a long transcript (over 24,000 characters) the model gets the first 12,000 and the last 12,000, with a note in the text saying the middle was left out. A recap that fails is not tried again for the same transcript, so there is no endless retrying. The Edit workspace dialog says how many meetings have a recap and shows the failures, for example **3 recaps failed: no key**. A meeting's recap shows as **AI recap** in its details, where **Delete** removes it and it is not written again. Recaps are what [workspace chat](workspace-chat.md) reads first when it looks across many meetings.

The model is chosen like **Automatic** (see [how Automatic chooses](live-notes-and-brief.md#model-detail-and-language)). The switch names it: "uses the automatic model, ...".

### The knowledge base buttons

When the local knowledge base is on, the bottom of the Library shows **Build the knowledge base** or **Update the knowledge base**, **Test a search**, and a warning when settings changed and it needs a rebuild. They work as they always did.

## What is shared between workspaces

Workspaces share **material**: documents, folders, tools, talking points and saved memory. They never share meetings or chats. A workspace's meetings and chats only ever come from that workspace.

A meeting uses:

- The workspace it is filed in (its **home**)
- **General**, when the home has **Also use General** on
- Any workspace you picked as **Also use** for this meeting (this is called borrowing)

The instructions come from the home workspace only.

A workspace chat uses its own workspace and, if **Also use General** is on, General. Borrowing is for meetings.

### Keep separate

**Keep separate** is for work that must not mix with anything else, for example one client's. A kept-separate workspace:

- Never uses General's material
- Can't borrow another workspace
- Can't be borrowed by another workspace

NexQ explains why when you try. If a workspace becomes kept separate, every borrow involving it ends.

### Changing it during a meeting

The meeting window has a workspace button in its header. Its menu has **File in ...** choices (the home) and **Also use ...** switches. The change applies from the next answer on, and NexQ says so: what was already said stays in the call. A Claude subscription session may restart in the background to pick up the change. If a change takes material away, what was made from that material for this meeting goes too: its brief, its own versions of talking points and their ticks.

## Move a meeting

Use **Move to workspace** on a meeting in the list or in the meeting details. You can't move a meeting to an archived workspace.

When a meeting leaves a workspace, that workspace forgets what it learned from it:

- Memory suggestions made from it are removed. Memory you saved keeps its text but loses its link to the meeting
- Its chats stop using the meeting. Their condensed summaries are dropped, because they may quote it, and the sources that pointed to it lose their title and text
- Borrows that no longer make sense end

## Files, folders and tools in no workspace

NexQ only fills General once, at the upgrade. After that, a document, folder or tool that reaches the library without being filed anywhere is listed as **not in any workspace** in **Add > Files, folders and tools in the library**, and no meeting or chat uses it. Add it to a workspace from that list. Things you add from a workspace, or from Settings, are filed together with the add (from Settings they go to the default workspace).

## Clone

**Clone** makes a copy of a workspace. It copies the colour, description, instructions, its settings, the files, folders and tools it uses (with your names and pins) and its talking points. It does not copy meetings, chats, memory or secrets, and the copy starts with **Search its text** off on every folder.

## Archive and delete

**Archive** hides a workspace from the list. Everything stays, and **Show archived** lists it again. **Bring back** undoes it. You can't start a meeting in an archived workspace or borrow one.

**Delete** asks what happens to what is in it:

| Choice | What happens |
|--------|--------------|
| **Move to General** (the default) | Its meetings, chats and talking points go to General. Its saved memory is deleted with it, and the dialog says how many items. Files stay in your library |
| **Archive it instead** | Hides it. Everything stays, memory included |
| **Delete everything in it** | Permanently removes its meetings (with their recordings), chats, talking points and memory. This can't be undone |

Other workspaces' chats that used material of this one stop using it, and a chat answer that is being written from it stops (see [Workspace chat](workspace-chat.md#when-something-an-answer-used-leaves-the-workspace)). Documents are never deleted from the library by deleting a workspace. Meetings that borrowed the workspace lose what came from it.

## What happens when you upgrade

NexQ adds workspaces to your existing data, and it does that safely:

1. **A copy first.** Before changing your database for the first time, NexQ saves a copy of it as `nexq-before-workspaces.db` in the app data folder, next to `nexq.db` (`%APPDATA%\com.nexq.app\` on Windows). It does this only if you have meetings or documents, and only once. The copy is deleted at the first start after 14 days, because it still holds transcripts you may have deleted since. If the copy can't be made, NexQ writes that to its log and carries on, since the upgrade only adds things.
2. **Everything goes into General.** All your meetings, documents, folders and tools are in General, and General is the default workspace. Until you make another workspace, answers work as before. A note at the top says so until you dismiss it: "Your meetings and files are in General. New workspaces keep their own."
3. **The upgrade is all or nothing.** If a step of the workspace upgrade fails, nothing is changed. NexQ shows "Workspaces aren't available right now. Everything is in General, and NexQ works as before." and tries again the next time it starts.
4. **Folders are not searched yet.** Every folder starts with **Search its text** off, until you turn it on.

## If NexQ can't open your meetings

NexQ never creates, upgrades or overwrites a database it can't use. Instead of the workspaces, the launcher shows a screen that says what is wrong, that nothing was deleted, and the full path of your file (`nexq.db`). Settings and the footer still work, and you can't start a meeting from it. The four cases:

| Title | What it means | What you can do |
|-------|---------------|-----------------|
| **NexQ couldn't open your meetings** | The file couldn't be read (damaged, cut short, empty) | **Restore a copy**, **Open data folder**, or **Start with an empty database** |
| **Your meetings were saved by a newer NexQ** | This version is older than the one that last used them, so it leaves them alone | **Install the newer NexQ**, **Open data folder** |
| **NexQ couldn't finish updating your data** | Bringing your meetings up to this version didn't complete | **Try again** (restarts NexQ), **Open data folder** |
| **Your meetings are in use** | Another NexQ or program is using the file | **Try again** once you have closed the other program, **Open data folder** |

**Copies.** For a damaged file, **Restore a copy** lists the copies NexQ can open and check, with the date, time, number of meetings and size. NexQ makes `nexq-before-workspaces.db` at the upgrade (kept 14 days); a restore also keeps the files it replaces, as `nexq.db.damaged-` and a number. A restore, and **Start with an empty database** (which asks first), put the old files aside under new names. They never delete anything, and NexQ asks you to restart afterwards. If the power goes out in the middle, the next start undoes a recovery that had not put every old file aside, and leaves your file as it was. If every old file was already aside, it finishes the recovery. Neither works while a meeting or a recording is in progress.

**A daily check.** About two minutes after NexQ starts, and then at most once a day (never during a meeting or while a recording is saved), NexQ checks the open file for damage without changing it. If it finds some, a notice says **Your meetings file has some damage**, that NexQ keeps working with it and has changed nothing, and where the copies of your meetings are. Closing the notice hides it until the next start, and it returns while the damage is there.

## Tips

- **One workspace per client, job or course.** Put the documents and instructions that belong together in it. The more you keep out, the more relevant the answers.
- **Keep General for what is truly shared.** Turn on **Also use General** for the workspaces that need it.
- **Use Keep separate for anything confidential.** It is the one setting that is enforced both ways.
- **Name your files.** A name like "Pricing 2026" helps you read the Library and the answers' sources.

## Next Steps

- [Workspace chat](workspace-chat.md): ask questions across a workspace's meetings and files
- [Meeting window layout](meeting-layout.md): arrange the panels
- [Talking points](talking-points.md): notes you read during a call
- [Live notes and the brief](live-notes-and-brief.md): notes written while you talk
- [Using Context Intelligence](rag-context.md): documents and the local knowledge base
