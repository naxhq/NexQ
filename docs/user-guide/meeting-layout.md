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

A layout only decides where panels go. Panels it doesn't use are hidden, not closed. They keep their state, and live notes keep taking notes while they are out of sight.

### Save your own

Type a name in **Save this layout as...** and click **Save**. It appears under **Your layouts**. Click it to use it again. The pencil renames it and the bin deletes it. You can keep 20.

### Reset

**Reset to Classic** brings back the default arrangement and shows the panels Classic shows.

## Move a panel

Each stack of panels has a row of tabs. A panel can share a stack with others, as tabs.

**With the mouse.** Press a tab and drag it. As you move over the window, a preview shows where it would land:

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

Drag the thin line between two panels. It snaps to the middle and to the lines of neighbouring panels; hold `Alt` while dragging to move freely. Double-click the line to even the two sides out.

With the keyboard, `Tab` to a separator and use the arrow keys (16 pixels at a time, 64 with `Shift`), `Home` and `End` for the smallest and largest size, and `Enter` to even out.

## Hide, show and collapse

- **Hide.** Open the **Layout** menu and untick the panel under **Panels**, or choose **Hide ...** in its **Move** menu. Tick it again to bring it back.
- **Collapse.** **Collapse to a strip** shrinks a panel to a thin bar. Click the bar to open it again. The header's view button does this for you: **Focus AI panel**, **Focus Transcript**, **Split view**.
- **The assistant comes back by itself** when you use the Ask key, or when a screenshot is captured, even if you hid it or it is a tab behind another one.

## Lock the layout

**Lock layout** in the menu freezes the arrangement, so a stray drag can't change it. While it is locked:

- Dragging, moving, resizing, choosing a layout and **Reset to Classic** do nothing
- You can still show, hide and collapse panels
- The Move menu says: "Layout is locked. Unlock it from the Layout menu to move panels."

The menu says **Layout locked** while it is on. Click it again to unlock.

## Small windows

When the window is too small for the arrangement, NexQ doesn't squeeze panels until they are unreadable. It first lets a side-by-side pair stack on top of each other, and if that doesn't fit either, it merges the panels into one set of tabs. Your saved layout isn't changed, so making the window bigger brings it back. Classic is designed to look the same as before at 400, 500 and 900 pixels wide. While the panels are merged, dragging and moving are off.

The meeting window opens at 500 by 700 pixels (smallest 400 by 480). It remembers its size and place, and moves back onto a connected screen if its monitor is gone.

## Readability

Panels with text to read (Transcript, Assistant, Live notes, Brief, Talking points and AI Call Log) keep a backing behind the text, so it stays readable when you make the window transparent. Together with the window, the backing stays about 85 percent opaque.

## Tips

- **Presenting?** Choose **Presenter**: your notes next to the assistant. Turn on **Hide from screen share** first.
- **Taking notes?** Choose **Notes**, and keep the transcript above the assistant.
- **Found a layout you like?** Save it and lock it.
- **Panel gone?** Open **Layout > Panels**. A hidden panel is never lost.

## Next Steps

- [Talking points](talking-points.md): the notes you read in the Talking points panel
- [Live notes and the brief](live-notes-and-brief.md): the two helper panels
- [Keyboard Shortcuts](keyboard-shortcuts.md): every key in one place
