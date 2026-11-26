# Using Context Intelligence (RAG)

NexQ's Context Intelligence feature lets you load your own documents so the AI can reference them during meetings. When you load your resume, a job description, course notes, or project documentation, the AI uses that context to provide more relevant and informed responses.

Documents belong to [workspaces](workspaces.md). A meeting only uses the documents of its own workspace, of General if that workspace uses it, and of workspaces you chose to also use for that meeting. Documents of other workspaces never reach its answers.

## Prerequisites

- NexQ installed and running ([Getting Started](getting-started.md))
- An LLM provider configured ([AI Providers Guide](ai-providers.md))
- Documents you want to load (PDF, DOCX, TXT, or MD format)

## What RAG Does

RAG (Retrieval-Augmented Generation) works by:

1. **Chunking** your documents into smaller sections
2. **Embedding** each chunk as a vector (numerical representation of meaning)
3. **Indexing** the chunks in a local SQLite database
4. **Searching** for relevant chunks when the AI needs context during a meeting
5. **Including** the most relevant chunks in the AI prompt alongside the conversation

The result: the AI can reference your documents when generating responses, making its suggestions more specific and useful.

## Supported File Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| PDF | `.pdf` | Text-based PDFs. Scanned image PDFs are not supported. |
| Word | `.docx` | Microsoft Word documents |
| Plain Text | `.txt` | Any plain text file |
| Markdown | `.md` | Markdown formatted documents |

## Loading Documents

### Step by Step

1. Open the workspace the meeting will be filed in (you start with **General**)
2. In the **Library** on the right, click **Choose files**, or **Add** and then pick what to add. You can also drop files on the window
3. Select one or more files from the file picker (multiple selection is supported)
4. When the local knowledge base is on, indexing begins automatically. Progress shows in the Library
5. Wait for indexing to complete before starting your meeting

To use a document you already added in another workspace, choose **Add > Files, folders and tools in the library**. Each document exists once, and workspaces point to it.

### What Happens During Indexing

When you add a document, NexQ processes it through a 4-phase pipeline:

1. **Extract** -- reads text content from the file
2. **Chunk** -- splits the text into overlapping segments (configurable chunk size)
3. **Embed** -- generates vector embeddings for each chunk
4. **Index** -- stores chunks and embeddings in the local SQLite database with full-text search support

Indexing is fully asynchronous -- progress events (`rag_index_progress`) update the UI in real-time. You can continue using NexQ while indexing runs, but AI responses will only reference indexed content.

## How Search Works

When the AI needs context during a meeting, NexQ searches your indexed documents using hybrid search:

- **Vector similarity search** -- finds chunks with meaning similar to the current conversation
- **Full-text search (FTS)** -- finds chunks containing specific keywords or phrases
- **Hybrid mode** -- combines both methods for the best results (default)

The top matching chunks are included in the AI prompt, limited by the token budget. In a live answer they are handed to the model as data: each excerpt is fenced, numbered as a source so an answer can cite it, and the prompt says that text inside is never an instruction.

## Live answers and workspace chat

Context Intelligence is what **live answers** use during a meeting. The [workspace chat](workspace-chat.md) uses a search of its own: a local keyword index of the workspace's meetings, documents, folders you allowed and notes. It doesn't need the embedding model, and you can use it with the local knowledge base off.

Whichever strategy you use in **Settings > Context Strategy** (**Local RAG**, **Gemini Context Cache**, or sending the documents whole), the documents a live answer can use are filtered to the meeting's workspace first, before anything is ranked or sent. Instructions you wrote for the workspace are added after your general custom instructions.

## Configuration

![Context Strategy settings panel](../../website/public/screenshots/Setting/Setting-Context%20Strategy.png)

Open Settings (`Ctrl+,`) > Context Strategy to configure RAG parameters:

| Setting | Description | Default |
|---------|-------------|---------|
| Chunk Size | How many tokens per document chunk | Provider default |
| Chunk Overlap | Overlap between adjacent chunks (for context continuity) | Provider default |
| Top-K Results | Number of relevant chunks included in each AI request | 5 |
| Similarity Threshold | Minimum relevance score for a chunk to be included | 0.7 |
| Search Mode | Semantic, Keyword (FTS), or Hybrid | Hybrid |

### Token Budget

Each AI request has a limited token budget for context. The token budget determines how many document chunks can be included alongside the conversation transcript. If you load many documents, only the most relevant chunks are selected within the budget.

## Best Practices by Use Case

### For Interviews

Load focused, relevant documents:

- Your **resume** (1-2 pages) -- so the AI knows your background
- The **job description** -- so the AI understands the role
- **Company research notes** -- key facts, recent news, products
- **Common interview questions** for the role -- the AI can help frame your answers

### For Lectures

Load course materials for richer AI responses:

- **Syllabus** -- helps the AI understand the course structure
- **Textbook excerpts** -- key chapters related to the lecture topic
- **Previous lecture notes** -- provides continuity across sessions
- **Study guides** -- the AI can reference these when answering your questions

### For Meetings

Load project context:

- **Project documentation** -- specs, requirements, design docs
- **Previous meeting notes** -- the AI can reference past decisions
- **Relevant reports or data** -- the AI can cite specific numbers or findings

## Clearing Context

To remove documents from the RAG index:

1. Open the workspace and find the document in the **Library**
2. Open its **...** menu
3. Choose **Remove from this workspace** to stop using it here. Other workspaces keep it
4. Choose **Remove from library** to remove it everywhere. It leaves every workspace that uses it, and its chunks and embeddings are removed from the index

Removing a document does not delete the original file. It only removes it from NexQ.

## Tips

- **Smaller, focused documents work better than large dumps.** A 2-page resume produces better context matches than a 50-page portfolio. The AI retrieves the most relevant chunks, so concise documents mean every chunk is useful.
- **Wait for indexing to complete before starting a meeting.** Only indexed content is available to the AI. Check the progress indicator before beginning.
- **Update documents when they change.** If you update your resume or project docs, remove the old version and re-add the new one to refresh the index. **Index again** in the document's **...** menu rebuilds only its index.
- **Use Hybrid search mode** (the default) for the best results. It combines semantic understanding with keyword matching.
- **Check the AI's responses** to see if it is referencing your documents. If responses seem generic, verify that indexing completed and that your documents are relevant to the conversation topic.
- **For embedding models**, if you are using Ollama for LLM, you can also use it for embeddings. Pull an embedding model like `nomic-embed-text`:
  ```
  ollama pull nomic-embed-text
  ```

## Next Steps

- [Interview Copilot Guide](interview-copilot.md) -- Load resume and job description for interviews
- [Lecture Assistant Guide](lecture-assistant.md) -- Load course materials for lectures
- [AI Providers Guide](ai-providers.md) -- Choose the best LLM for RAG-enhanced responses
- [Configuration Guide](configuration.md) -- Full RAG configuration options
