# Memory

Memory is a short list of facts a workspace keeps for you: who someone is, what you decided, what is still open, what a person prefers. The AI reads it as background in this workspace's answers, so you don't have to say it again. Nothing goes in without your say-so.

## Prerequisites

- NexQ installed and running ([Getting Started](getting-started.md))
- A [workspace](workspaces.md). You already have **General**
- For suggestions after a meeting: an LLM provider set up ([AI Providers Guide](ai-providers.md))

## Where it lives

Memory is a section of the **Library** panel on the right of a workspace, under **Talking points**. Its header shows how many items there are. Items are grouped by kind, and each row shows an icon, the title, the kind and one line of the text.

| Kind | Use it for |
|------|------------|
| **Person** | Who someone is and what they care about |
| **Decision** | Something that was agreed |
| **Open item** | Something still to do or to answer |
| **Fact** | A figure, a date, a detail worth keeping |
| **Preference** | How someone likes things done |

## Add an item by hand

1. Click **+** in the Memory header.
2. Choose a kind, give it a short title (for example "Priya Raman" or "Budget cap") and write what to remember.
3. Click **Add**.

Click a row to read the whole text. **Edit** changes it. **Forget** deletes it, and asks first. With more than four items a search box appears.

## Let NexQ suggest items

Memory suggestions come from a meeting's transcript. They are proposals only.

1. Open a past meeting that is filed in the workspace.
2. Click **Suggest from this meeting**. A meeting that is not filed in a workspace has nowhere to keep memory, so the button is off and asks you to file the meeting first.
3. NexQ reads the transcript in pieces of about 10,000 tokens, one AI call for each, at most 4 calls. A longer meeting keeps its start and its end and drops the middle. In all it proposes up to 8 items, each with the moment in the meeting it came from.
4. The suggestions wait in the workspace's Memory. For each one you can **Dismiss** it, **Edit** it or **Save** it. Tick **Reviewed** on the ones you have read and use **Save all reviewed** to keep them in one go.

A suggestion that the transcript doesn't back up is marked **Not found in the transcript**, so you can tell it apart from one that is.

To get suggestions after every meeting without clicking, turn on **Suggest after meetings** in the Memory section. It is off by default.

### The model for suggestions

**Model** in the Memory section (and the **Model** button beside **Suggest from this meeting**) picks the model that proposes items. **Automatic**, the default, names the model it will use: with a subscription it is the fast tier, with the main API providers a small model once your provider's list is known, and with Ollama, LM Studio or a custom server your active model. The same rule is used for the [brief](live-notes-and-brief.md#model-detail-and-language). If NexQ can't read or save the choice, it says so.

## Link back to the moment

An item that came from a meeting has a **From (meeting)** link. It opens the meeting on its transcript at the time the fact was said, so you can check it.

## Where memory is used

- **Workspace chat.** Saved memory goes in first, up to 1,500 tokens ([Workspace chat](workspace-chat.md)).
- **Live answers** in a meeting of this workspace.
- **The brief.** It receives your saved memory with the passages it found ([Live notes and the brief](live-notes-and-brief.md)).

Memory is handed to the model as background facts, never as instructions. It stays in the workspace it was saved in. It reaches another workspace only when that workspace borrows this one for a meeting, or uses General.

Live notes never read your memory.

## When a meeting leaves the workspace

Memory suggestions made from a meeting are removed when you move the meeting to another workspace. Items you saved keep their text but lose their link to the meeting. Deleting a workspace with **Move to General** deletes its saved memory with it, and the dialog says how many items ([Workspaces](workspaces.md#archive-and-delete)).

## Privacy

- Your memory is stored in NexQ's database on your PC.
- Suggestions are made by the model you pick, so the transcript goes to that provider. With a local model (Ollama or LM Studio) it stays on your PC.
- Saved memory goes to the provider that answers whenever an answer uses it.

## Tips

- **Keep items short and plain.** One fact per item reads and checks better.
- **Review before you save.** Suggestions can be wrong. The link to the moment is there for that.
- **Forget what is out of date.** An old decision that was reversed will mislead later answers.

## Next Steps

- [Workspaces](workspaces.md): what a workspace holds and shares
- [Workspace chat](workspace-chat.md): ask across a workspace's meetings and files
- [Live notes and the brief](live-notes-and-brief.md): help during the call
