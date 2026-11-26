# Talking Points

Talking points are your own notes, kept in a workspace, that you read from during a call. They are formatted the way you wrote them. NexQ can scroll them as you speak and tick off what you have already said. The AI can also use them as background for its answers, if you let it.

## Prerequisites

- NexQ installed and running ([Getting Started](getting-started.md))
- A [workspace](workspaces.md). You already have **General**

## Write your notes

1. Open a workspace. In the **Library** on the right, find **Talking points** and click **New note**.
2. A wide editor opens. Give the note a title and write.
3. Your changes save as you type. The corner says **Saving** and then **Saved**.

The toolbar has bold, italic and underline, three heading sizes, bullet and numbered lists, text colour, text size, undo and redo. The colours are chosen to stay readable on dark and light backgrounds. Pasted text is cleaned up, so it takes your formatting rather than the source's, and hidden characters are removed from what you paste from outside. What you type is saved exactly as you typed it (a Persian half-space or a joiner stays). Hidden characters are only taken out where text goes into an AI request.

**Import** brings in Markdown from a file (up to 2 MB) or from pasted text. Headings, lists, bold and italic are kept. Links become plain text, and images and HTML are left out. It creates a new note.

For each note:

- **Use as AI context** is a switch under the title: "Live answers and the workspace chat can draw on this note." It is **on** for a new note. Turn it off for notes that are only for you to read. When you edit such a note during a meeting, the change reaches the AI session about 30 seconds after you stop typing, not on every autosave.
- The **...** menu in the list has **Duplicate**, **Copy to another workspace**, **Move up**, **Move down** and **Delete**. Drag the grip beside a note, or focus it and press an arrow key, to reorder.
- **More for this note** has **Export as Markdown** and **Copy Markdown**.

If the same note is changed in two windows, nothing is overwritten. NexQ says **Changed in another window** and asks which to keep: **Keep mine** or **Use theirs**. **See both** shows the other version's text. A change always says which version it started from, so an older save can't replace a newer one. If saving fails, it says **Not saved** and keeps trying, and **Try now** tries at once.

Your notes belong to a workspace. A meeting can read the notes of its own workspace, of General when the workspace uses it, and of any workspace you chose to also use for that meeting. Notes from another workspace show the workspace's name in the list.

## Read them in a meeting

Talking points are a panel in the meeting window. It is hidden in the default layout. To show it, choose **Layout > Panels > Talking points**, or pick the **Presenter** layout ([Meeting window layout](meeting-layout.md)). If you have no note yet, the panel offers **Write a note**.

At the top of the panel:

- The note's title. Click it to switch notes. Type to filter, `Up` and `Down` to move, `Enter` to open, `Escape` to close. Recently used notes come first.
- **Edit this note** (the pencil)
- **Reading settings**

The note is set as a clean page. The line you are saying sits on a thin marker in the upper third, in full contrast. What is ahead is a little fainter. What you have said settles back.

### Reading settings

| Setting | Range | Default |
|---------|-------|---------|
| **Text size** | 14 to 56 | 26 |
| **Line spacing** | 1.2 to 2.2 | 1.5 |
| **Speed** (words a minute, used by auto-scroll) | 60 to 260 | 140 |
| **Tick what I have said** | on or off | On |
| **Suggest where I am** | on or off | On |
| **Text style** | Classic, Checked off, Highlight, Focus or High contrast | Classic |

The **Text style** picker shows a small preview of each style. **Classic** fades lines as you pass them. **Checked off** strikes through in green what you said. **Highlight** puts a soft mark on the line you are on. **Focus** makes the current line stand out and lets the rest recede. **High contrast** keeps full strength everywhere and marks the state with lines.

With the note focused, `+` and `-` change the text size. NexQ remembers your settings and the last note you used in each workspace.

### How the note moves

Choose one of three modes under the panel header:

- **Manual** (the default). You scroll. Nothing moves by itself.
- **Auto**. The note scrolls at the speed you set. Click play, or press `Space` while the note is focused. In the note, `Space` plays and pauses and doesn't start an AI answer.
- **My voice**. The note follows what you say. See below.

If you scroll yourself in **Auto** or **My voice**, the note stops for 4 seconds and leaves control with you, and a **Resume** button offers to go back. If your system asks for reduced motion, the note jumps instead of gliding.

Other keys when the note is focused: `Enter` ticks the current line (or goes to the suggested point), `Backspace` goes back after a big jump, and the arrow, `Page` and `Home` or `End` keys scroll.

### Edit during the call

Click **Edit this note**. Change what you need, then choose:

- **Only this meeting**. The note in the workspace stays as it was. The title shows **edited for this meeting**.
- **Save to workspace**. Every later meeting gets the change too.
- **Cancel**

If the note was changed in another window since you started the edit, saving says "The note was changed in another window since you started this edit. Nothing was overwritten." and offers **Keep mine**, **Use theirs** and **See both**, whichever way you were saving.

## Follow my voice

In **My voice** mode, NexQ matches what you say to the note and scrolls to keep your place. It all happens on your PC. NexQ only listens to the "You" side of the call, never to the other people, and makes no AI request to do it.

**When it works.** It needs your own voice as a separate side. It isn't available, and the panel says why, when:

- The meeting is in person ("In an in-person meeting only the room is transcribed, so your own voice is not separate.")
- Your microphone is muted
- Your side has no speech engine ("Choose one in Settings, under Speech.")

**What it does.** It compares the last few words you said with the part of the note around your place. It copes with a line you skip, a point you take out of order and the odd ad-lib, and it moves a short way forward as soon as you get there. For a big jump it waits for stronger proof, usually a run of about 8 words. Until then, if **Suggest where I am** is on, it offers **Go to: ...** once the last 20 or so words you said clearly fit another point better than where you are (the same words, your own wording, or just naming the heading; forward or back). The offer waits about a second before it appears, comes at most once every 4 seconds, and a point you dismiss isn't offered again. The offer itself never moves the note: you click it. It can be wrong, mostly when you talk about something else with the note's own words, and it can miss a place. After a big automatic jump (about 25 words or more) you get **Back to where I was** for 8 seconds. When it isn't sure, it holds still. The state shows as:

| State | Meaning |
|-------|---------|
| **Following you** | It is sure of your place |
| **Listening** | It heard something but isn't sure |
| **Lost your place. Scroll to show me.** | Scroll to where you are and it picks up again |
| **Waiting for you** | You have been quiet |

### Honest limits

Following works on the words your speech engine writes down, so it is only as good as that transcript. It compares words, not meaning: if you say something in quite different words than the note, it may not notice. Numbers, names and jargon that the speech engine mishears can also cause a miss.

How well it handles your language is not equal. NexQ tells you when to be careful:

| Language | What NexQ says |
|----------|----------------|
| English, French | Nothing. These are matched best |
| Spanish, Portuguese, German, Arabic | **Ticks may be missed in** the language |
| Japanese, Chinese, Korean | **Ticks often miss rephrased lines in** the language |
| Others | Nothing is said, and matching is basic |

The language is the one set for your side in **Settings > Audio & Devices**. If that is on automatic, NexQ guesses it from the note. The note and your speech need to be in the same language. Number words ("four point two million" and "4.2M") are understood in English, Spanish, German, French and Portuguese. Chinese, Japanese and Korean are matched in overlapping pairs of characters.

Treat it as a help, not a guarantee. Keep **Manual** one click away, and scroll when it is wrong.

## Said it

With **Tick what I have said** on, each line of the note (a bullet or a paragraph, not a heading) gets a tick when you have said enough of it:

- At least three distinctive words from the line, or all of them if it has fewer
- About 60 percent of the weight of its distinctive words
- Said in the last 90 seconds, and close together

Ticked lines settle back. The panel shows **N left to say**, and **All said** at the end. Click a tick to turn it on or off yourself. What you set by hand is never changed by the automatic rule. Ticks are saved with the meeting, so they are still there if you reopen the window.

Ticks need your own voice, so they follow the same rules as **My voice**: not in person, not muted, with a speech engine. They work in any mode.

## Memory

A workspace can also keep **Memory**: short facts that you approved, such as a person's role, a decision, an open item or a preference. The AI uses them in this workspace's answers. Memory appears in the **Library**, under the talking points. The full story is in [Memory](memory.md).

**Add a fact** with **+**. Choose a kind (**Person**, **Decision**, **Open item**, **Fact** or **Preference**), give it a short title and write what to remember. Saved items are grouped by kind. **Edit** changes one and **Forget** deletes it (it asks first). With more than four items, a search box appears. An item that came from a meeting has a **From (meeting)** link that opens the meeting at that moment.

**Let NexQ suggest.** In a past meeting, click **Suggest from this meeting**. A meeting that is not filed in a workspace has nowhere to keep memory, so it says so and asks you to file it first. NexQ sends the transcript in chunks of about 10,000 tokens, one AI call each, at most 4 calls (a longer meeting keeps its start and end and drops the middle), and proposes up to 8 items in all, each with the time in the meeting it came from. Nothing is kept until you approve it: each suggestion has **Dismiss**, **Edit** and **Save**, a **Reviewed** tick, and **Save all reviewed**. A suggestion that isn't backed by the transcript says **Not found in the transcript**. To have suggestions made after every meeting, turn on **Suggest after meetings** in the Memory section. It is off by default. **Model for memory suggestions** (in the Memory section, and behind the **Model** button next to **Suggest from this meeting**) picks the model. **Automatic**, the default, names the model it will use ([how Automatic chooses](live-notes-and-brief.md#model-detail-and-language)). If NexQ can't read or save the choice, it says so.

Memory is used as background facts, never as instructions. It is used in the workspace's chat and in live answers, and it reaches another workspace only if that workspace is borrowed or General is included. Meeting suggestions are made by the model you pick, so the transcript goes to that provider.

## What the AI sees of your notes

- A note marked **Use as AI context** is used in live answers and in the workspace chat. It goes to the provider that answers, like your documents.
- A note that is not marked is never sent anywhere. It is only for you.
- Live notes never read your talking points ([Live notes and the brief](live-notes-and-brief.md)).

## Tips

- **Write short lines.** One idea per bullet ticks and follows best.
- **Keep the order you will say them in.** Following allows skips, but a clear order helps.
- **Rehearse once.** Start a test meeting, read the note aloud and see how it follows you.
- **Switch notes with the title button.** Keep one note for the opening, one for the close.

## Next Steps

- [Meeting window layout](meeting-layout.md): show the Talking points panel and place it where you like
- [Workspaces](workspaces.md): where your notes live
- [Live notes and the brief](live-notes-and-brief.md): notes the AI writes for you
- [Audio Setup Guide](audio-setup.md): a speech engine for the You side
