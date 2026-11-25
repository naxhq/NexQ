# Meeting Window Layout

The meeting window is made of panels: the transcript, the assistant, live notes, talking points and so on. You can choose which panels to show and where each one sits. NexQ remembers your arrangement for the next meeting.

By default the window looks like it always did, with the transcript on the left and the assistant on the right. This layout is called **Classic**.

## Prerequisites

- A running meeting. The layout controls are in the meeting window's header

## The panels

| Panel | What it shows |
|-------|---------------|
| **Transcript** | The live transcript, both sides |
| **Assistant** | The question box, the action buttons and the answer |
| **Live notes** | Notes written while you talk ([Live notes and the brief](live-notes-and-brief.md)) |
| **Brief** | A short sheet of what the workspace knows about the topic ([Live notes and the brief](live-notes-and-brief.md)) |
| **Talking points** | Your own notes to read from ([Talking points](talking-points.md)) |
| **Bookmarks** | The bookmarks of this meeting |
| **Stats** | Speaker statistics |
| **AI Call Log** | Every AI request of the meeting |
| **Dev Log** | Audio and speech messages for troubleshooting |

The header, the mute buttons, **End meeting** and the status bar are always there. They are not panels.

In Classic, only **Transcript** and **Assistant** are on screen. The others are hidden until you ask for them. The header buttons, `S` (stats), `K` (bookmarks) and `Ctrl+Shift+L` (dev log) show or hide a panel on the spot. `Escape` puts away the panels you opened that way, and so does a new meeting. The assistant is never put away by `Escape`.

## Choose a layout

Click **Layout** in the header (the small grid icon) to open the menu. At the top are five layouts, each with a small picture:

| Layout | What it gives you |
|--------|-------------------|
| **Classic** | Transcript on the left, assistant on the right, side by side |
| **Focus** | The assistant takes most of the window. The transcript is a thin strip on the left that opens when you click it |
| **Notes** | The transcript above the assistant on the left. **Live notes** and **Brief** as tabs on the right |
| **Presenter** | **Talking points** and **Brief** as tabs on the left. **Assistant** and **Transcript** as tabs on the right |
| **Everything** | Transcript, AI Call Log and Dev Log as tabs on the left. The assistant on top of live notes, brief, talking points, bookmarks and stats on the right |

A layout only decides where panels go. Panels it doesn't use are hidden, not closed. They keep their state, and live notes keep taking notes while the panel is out of sight (a hidden panel only stops drawing and polling: see [Hide, show and collapse](#hide-show-and-collapse)).

### Save your own

Type a name in **Save this layout as...** and click **Save**. It appears under **Your layouts**. Click it to use it again. The pencil renames it and the bin deletes it. After a delete, the menu says **Deleted "name"** with **Undo**, which brings it back at its old place. Undo stays until you close the menu or delete another layout. You can keep 20.

### Reset

**Reset to Classic** brings back the default arrangement and shows the panels Classic shows.

## Move a panel

Each stack of panels has a row of tabs. A panel can share a stack with others, as tabs.

**With the mouse.** Every tab starts with a small handle of six dots. The tab you are on always shows it quietly; the others show it when you point at them. Point at the dots for a moment, or move to a tab with the keyboard, and a tip says **Drag to move** and **Right-click or Shift+F10 for options** (it does not appear when you click a tab). Press the tab and drag it. A small chip follows the pointer with the panel's name and, under it, what dropping here will do (for example **Right of Transcript**, **Above Assistant**, **Tab in Notes**, **Left edge of the window**, **Reorder**, or **No change here**). The words describe what you will see in this window: in a small window a drop that would go beside a panel may be drawn below it, and then the chip adds **(stacked here)**; when there is no room to split at all it says so, for example **Tab with the other panels (window too small to split)** or **Tab in Notes (window too small to split)**. The highlighted area shows where; the chip says what. Before the pointer is over anything, thin dashed outlines show every area the panel can land on, and the chip says **Move over an outlined area**. For your first five drags a short note at the bottom says **Drop on a highlighted area to rearrange. Esc cancels.**; it moves to the top when the pointer is near the bottom. As you move over the window, a preview shows where it would land:

- The left, right, top or bottom of another panel puts it beside, above or below that panel
- The middle of another panel adds it as a tab there
- The edge of the window gives it a full-height or full-width place of its own

Release to drop it. `Escape` cancels the drag. Drag a tab sideways along its own tab row to reorder the tabs.

**With the keyboard.** Focus a tab, then:

| Key | What it does |
|-----|--------------|
| `Left` and `Right` | Move to the previous or next tab |
| `Home` and `End` | First or last tab |
| `Alt+Shift+Left` and `Alt+Shift+Right` | Move this tab one place in its row |
| `Menu` key, `Shift+F10` or `Alt+Down` | Open the **Move** menu |

The **Move** menu is also under the **...** at the end of each tab row, and on right-click. It lists every place the panel can go, for example **Left of Assistant**, **Below Transcript**, **Tab with Assistant**, **Split out to the right**, **Left edge**, plus **Collapse to a strip** and **Hide Transcript**. NexQ announces each move to screen readers.

## Resize

Drag the thin line between two panels. A small handle of three dots appears on it when you point at it. It snaps to the middle and to the lines of neighbouring panels; hold `Alt` while dragging to move freely. Double-click the line to even the two sides out.

With the keyboard, `Tab` to a separator and use the arrow keys (16 pixels at a time, 64 with `Shift`), `Home` and `End` for the smallest and largest size, and `Enter` to even out.

## Hide, show and collapse

- **Hide.** Open the **Layout** menu and untick the panel under **Panels**, or choose **Hide ...** in its **Move** menu. Tick it again to bring it back.
- **Collapse.** **Collapse to a strip** shrinks a panel to a thin bar. Click the bar to open it again. The header's view button does this for you: **Focus AI panel**, **Focus Transcript**, **Split view**.
- **A hidden panel, or one behind another tab, does no work.** The talking points reader, for example, stops scrolling and polling until you see it again.
- **The assistant comes back by itself** when you use the Ask key, or when a screenshot is captured, even if you hid it or it is a tab behind another one.

## Lock the layout

**Lock layout** in the menu freezes the arrangement, so a stray drag can't change it. While it is locked:

- Dragging, moving, resizing, choosing a layout and **Reset to Classic** do nothing
- You can still show, hide and collapse panels
- The tab handles turn into a small lock when you point at them. A tip says **Layout is locked** and **Click the lock for the unlock option**. Clicking the lock (or the menu key, `Shift+F10` or `Alt+Down` on a tab) opens the **Move** menu, which says "Layout is locked: panels can't move" and has **Unlock layout**

The first line of the **Layout** menu reminds you to drag panels by their dots (it is left out while the layout is locked). The menu says **Layout locked** while the lock is on. Click it again to unlock.

## Small windows

In a narrow window the header keeps two rows instead of three. Below about 1040 pixels the view buttons move into one **More view options** menu: **Focus AI panel** (or **Focus Transcript**, or **Split view**), **Speaker stats** (`S`), **Bookmarks** (`K`), **AI call log**, **Dev log** (`Ctrl+Shift+L`) and **Transparency** (each press cycles it). The panels in the menu show a tick when they are on. The **Translate** button keeps only its icon.

The model and speech chips in the footer of the meeting window are buttons. `Tab` to one, press `Enter` or `Space` to open its list, and focus moves into the list: `Up`, `Down`, `Home` and `End` move, `Escape` closes it and focus returns to the chip. The lists open above the footer, inside the window, so a narrow window never cuts them off. The mute chips are buttons too (**Mute You**, **Unmute Them**).

When the window is too small for the arrangement, NexQ doesn't squeeze panels until they are unreadable. It first lets a side-by-side pair stack on top of each other, and if that doesn't fit either, it merges the panels into one set of tabs. Your saved layout isn't changed, so making the window bigger brings it back. Classic is designed to look the same as before at 400, 500 and 900 pixels wide. While the panels are merged, dragging and moving are off.

The meeting window opens at 500 by 700 pixels (smallest 400 by 480).

### Where the windows come back

NexQ remembers the size and place of the dashboard and the meeting window, and whether the dashboard was maximised (the size it had before is kept behind it). Starting a meeting, ending one, minimising, hiding to the tray, switching with `Ctrl+B` and restarting for an update all put them back where you left them.

- **Each set of monitors has its own place** (told apart by the monitors and their scale, not by the taskbar: hiding the taskbar or showing a captions bar changes nothing). Docked at your desk and undocked on the laptop are remembered separately (the last six setups). Unplugging a monitor never overwrites the place saved for the setup with it. Plug it back in and the windows go there again.
- **A setup NexQ has not seen** leaves a window where it is, and only brings it back inside a screen if it could no longer be reached. At app start it gets the same relative place on your main screen, the same size.
- **Mixed screen scales** (for example 125% and 150%) are handled: a window comes back on the right monitor at the right size.
- **While you drag a window**, NexQ never moves it. If the monitors change while you are working, the windows move to that setup's place a moment after you let go.
- The place is saved a moment after you move or resize, and again when you close the window, quit, install an update or end a meeting.

If a window ends up out of reach, use **Settings > General > Reset window positions** (your main screen), or the tray menu item **Bring windows to this screen** (the screen the mouse is on, otherwise the main one). Both put the dashboard and the meeting window back on that screen, not maximised, and forget the saved places.

The layout of the panels (splits, sizes, tabs, collapsed strips, hidden panels, locked, saved layouts, transparency) is saved separately and is not changed by the window size: panel sizes are kept as shares of the window, so a small window never permanently squashes a layout you made in a big one.

## Readability

The meeting window is see-through, and what is behind it is unknown (a white page, a black one, a busy photo). At every transparency step NexQ keeps the window's own text and icons (the header, the footer, badges and labels) readable against the worst background they could sit on. It first makes the muted colours a step stronger, and only if that is not enough adds a backing behind the header and the footer. At full opacity nothing changes. Panels with text to read (Transcript, Assistant, Live notes, Brief, Talking points and AI Call Log) also keep a backing behind the text. Together with the window, it stays at least about 85 percent opaque. The default transcript and answer colours follow the theme, so they read in the light theme too.

## Tips

- **Presenting?** Choose **Presenter**: your notes next to the assistant. Turn on **Hide from screen share** first.
- **Taking notes?** Choose **Notes**, and keep the transcript above the assistant.
- **Found a layout you like?** Save it and lock it.
- **Panel gone?** Open **Layout > Panels**. A hidden panel is never lost.

## Next Steps

- [Talking points](talking-points.md): the notes you read in the Talking points panel
- [Live notes and the brief](live-notes-and-brief.md): the two helper panels
- [Keyboard Shortcuts](keyboard-shortcuts.md): every key in one place
