# Troubleshooting

Common issues and solutions for NexQ. For detailed setup instructions, see the [Audio Setup Guide](audio-setup.md) and [AI Providers Guide](ai-providers.md).

Reporting a bug? Start with [Collecting logs for a bug report](#collecting-logs-for-a-bug-report).

## Installation Issues

### Windows SmartScreen Warning

**Problem**: Windows shows "Windows protected your PC" when running the installer.

**Solution**: This happens because the app is not yet code-signed. It is safe to proceed:

1. Click **"More info"** (the small text link below the warning message)
2. Click **"Run anyway"**

This only appears the first time you install. Subsequent launches will not trigger SmartScreen.

### Installer Fails to Run

**Problem**: The installer does not start or crashes immediately.

**Solution**:
- Ensure you downloaded the correct architecture (x64)
- Try right-clicking the installer and selecting "Run as administrator"
- Check that your Windows version is 10 or later
- Temporarily disable antivirus software if it is blocking the installer

## Audio Issues

### No Audio Detected

**Problem**: Audio level meters show no activity, or transcript shows nothing.

**Solution**:

1. **Check device selection**: Open Settings > Audio and verify the correct devices are selected for "You" (mic) and "Them" (system audio)
2. **Test devices**: Click the **Test** button next to each device to verify audio levels
3. **Check Windows permissions**: Go to Windows Settings > Privacy > Microphone and ensure NexQ has microphone access
4. **Check mute state**: Ensure neither "You" nor "Them" sources are muted in the overlay controls
5. **Restart audio**: End the current meeting and start a new one to reinitialize audio capture

### System Audio Not Capturing

**Problem**: "Them" transcript is empty even though you can hear remote participants.

**Solution**:

1. Verify the correct **output device** is selected for "Them" -- this should be the device your meeting app plays audio through
2. Check that audio is actually playing through that device (Windows sound mixer should show activity)
3. Open **Windows Settings > System > Sound** and confirm the correct default output device is set
4. Some devices may not support WASAPI loopback capture. Try selecting a different output device
5. If using a virtual audio cable or routing software, ensure it is configured correctly
6. See the [Audio Setup Guide](audio-setup.md) for detailed WASAPI loopback troubleshooting

### A Device Disconnects Mid-Meeting

**Problem**: A headset is switched off, a USB microphone is unplugged, or Windows changes the default device while a meeting is running.

**What NexQ does**:

- Reconnects that side by itself within about a second. The meeting, the recording and the other side keep going, and no window opens
- If the device you chose is gone, the default microphone or output stands in for it. NexQ goes back to your device by itself when it returns
- If nothing comes back after a minute, it tells you once and keeps trying every few seconds, so a device plugged back in later is picked up. You can also pick another device in Audio & Devices
- A quick reconnect to the same device is silent. Past a few seconds a "Reconnecting…" note stays until the side is back, and a message shows when the device changes or a side doesn't come back
- A virtual audio cable or an input shared by both sides has no stand-in, because the default microphone would pick up your own voice for the other side. NexQ waits for that device itself to come back
- Counts reconnects and audio glitches for each side in the audio stats line in the log, which is how to check how often it happened

If a side stays silent after you reconnected the device, pick the device again in Audio & Devices, or end the meeting and start a new one.

### Microphone Echo or Feedback

**Problem**: The other side's words also appear under "You", your own voice appears in the "Them" transcript, or there is echo.

**Solution**:

- Keep **Echo cancellation** on in Settings > Audio (on by default). It removes the speakers' sound from the microphone when "Them" is an output device
- Use headphones to prevent your speakers from feeding back into the microphone
- Ensure "You" and "Them" are using different physical devices
- Check that your meeting app has echo cancellation enabled

## Speech-to-Text Issues

### STT Not Working

**Problem**: Audio levels show activity but no transcript appears. After about 30 seconds of audio with no text, the meeting window shows a "No transcript from You/Them" warning naming the provider.

**Solution**:

1. **Update NexQ**: versions before v2.26.1 couldn't decode the Parakeet TDT 0.6B v3 model, so it heard audio but returned no text. Update from Settings > About.
2. **Don't use Windows Speech for "Them"**: Windows Speech only listens to your default microphone. It can't transcribe audio playing on your computer (Zoom, Teams, YouTube). Use Parakeet TDT, Deepgram or Groq for the other side.
3. **Check provider config**: Open Settings > STT and verify your provider is correctly configured
4. **Test connection**: Click **Test Connection** to verify the STT provider is reachable
5. **Check API key**: For cloud providers (Deepgram, Groq, Cartesia, Azure Speech, and Azure MAI Streaming), ensure your API key is valid and belongs to the configured resource
6. **Check internet connection**: Cloud STT providers require a stable internet connection. If your connection is intermittent, transcription may fail silently
7. **Try Web Speech API**: Switch to Web Speech API temporarily to verify audio is reaching the STT pipeline. If Web Speech works but your chosen provider does not, the issue is with the provider configuration
8. **Check the Dev Log**: press `Ctrl+Shift+L` in the meeting window for STT errors, or send your log (see [Collecting logs](#collecting-logs-for-a-bug-report))
9. See the [AI Providers Guide](ai-providers.md) for provider-specific setup instructions

### Azure MAI Streaming

**Problem**: **Save & Test** fails, Azure reports an authentication or model-availability error, or live text does not appear.

**Solution**:

- **Authentication failure / 401 / 403**: Re-enter a key from the Speech resource's **Keys and Endpoint** page. Make sure the configured region identifier exactly matches that resource; keys and regions must match.
- **Model unavailable**: Create the Speech resource in a supported Azure MAI Streaming region: `swedencentral`, `centralus`, `eastus2`, or `southeastasia`. Other Azure Speech regions do not imply this preview model is available there.
- **No transcript, but audio meters move**: In **Settings > Audio & Devices**, confirm Azure MAI Streaming is selected on the side you're testing. Check that the side's language is **Auto-detect** or a locale supported by the model. Test "You" and "Them" separately to isolate the capture path.
- **Network / connection failure**: NexQ retries temporary failures automatically while the channel is active. Speech during an outage is not replayed to Azure after reconnecting. Check internet access and whether a VPN, proxy, TLS inspection, or firewall blocks the Speech SDK's secure connection (including WebSockets over outbound port 443). On a managed network, ask IT to allow the Azure Speech service endpoints; Microsoft's [Speech SDK troubleshooting guide](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/troubleshooting) has current diagnostics.
- **Interim text appears, but a final result does not**: Interims are provisional updates, not confirmed transcript segments. Check the Dev Log for SDK/service errors and verify that the test speech is in a supported language. The feature is in public preview, so availability and behavior can change.

For a practical check, start a test meeting, speak on each configured side, verify that interim words update while speaking, then check that Azure final results settle into the transcript. This provider does not diarize speakers; multiple people on one side will not receive Azure speaker labels. See [Azure MAI Streaming setup](ai-providers.md#azure-mai-streaming-public-preview).

### Web Speech API Stops Working

**Problem**: Web Speech API transcription stops mid-meeting or becomes unresponsive.

**Solution**:

- Web Speech API has session limits in some browser engines. Ending and restarting the meeting resets the session
- Do not switch STT providers mid-session without stopping first -- hot-swapping the Web Speech API breaks the browser recognition session
- Ensure you have an active internet connection (Web Speech API may require it depending on the system)

### Cartesia Problems

**Problem**: Cartesia transcribes the wrong words, shows "reconnecting", or uses more credits than expected.

**Solution**:

- **Language**: Cartesia transcribes only English, French, Hindi, Japanese and Spanish. For other languages, choose a different provider. Settings > STT shows a warning when the selected language isn't supported
- **Reconnecting**: if the connection drops, NexQ reconnects on its own (after 1, 2, 4 and 8 seconds, then every 15 seconds) and keeps the sentence in progress. Speech while offline isn't transcribed
- **"Cartesia refused the API key or account"**: NexQ stops retrying. Check the key in Settings > STT and your credit balance at [play.cartesia.ai](https://play.cartesia.ai/usage)
- **Credits**: Cartesia bills every second of audio it receives while a channel is unmuted, including silence. One unmuted channel uses about 10,800 credits per hour; Cartesia on both "You" and "Them" uses about 21,600. Muting a channel closes its Cartesia stream, so muted time costs nothing; unmuting reconnects in a fraction of a second and keeps your first words. In in-person meetings the room mic is transcribed as "Them", so NexQ doesn't start a "You" provider at all, and "You" uses no credits

### Custom Whisper Endpoint

**Problem**: Whisper API with your own server fails the test, or transcription stops during a meeting.

**Solution**: Save & Test shows the server's own message. Common ones:

- **"Couldn't reach ... Is the server running?"**: the server isn't running, or the address or port is wrong. Open the same address in a browser (for example `http://127.0.0.1:8000/docs`) to check
- **"The server answered 404"**: usually the URL is missing `/v1`, or the server has no `/v1/audio/transcriptions` route. Use the base URL that ends in `/v1`, not the full transcription path
- **"The server answered 400" or "model not found"**: the **Model** name doesn't match a model the server has. Use the exact name it lists
- **"This server needs an API key"**: enter the key your server expects in "API key for this server". Your OpenAI key is never sent to a custom server
- **Ollama and LM Studio** don't do speech-to-text, so they can't be used here. Use a server built for transcription, such as faster-whisper-server (Speaches)
- **Fails mid-meeting**: NexQ shows the error once and clears it when the next segment succeeds. Whisper API sends audio in batches of about 5 seconds, so a slow server delays text; a request that takes more than 30 seconds is dropped

### Local Whisper Model Slow or Inaccurate

**Problem**: Local Whisper transcription has high latency or poor accuracy.

**Solution**:

- **Use a larger model** for better accuracy (large-v3 > medium > small > base > tiny)
- **Use a smaller model** for lower latency if accuracy is acceptable
- Switch to a cloud provider (Deepgram, Groq) for the best balance of speed and accuracy
- Close other CPU-intensive applications to free resources for the model

## LLM Issues

### AI Assist Not Responding

**Problem**: Pressing Space or clicking AI actions produces no response.

**Solution**:

1. **Check provider config**: Open Settings > LLM and verify your provider is connected
2. **Test connection**: Click **Test Connection** to verify the LLM provider is reachable
3. **Check API key**: For cloud providers, ensure your API key is valid
4. **Ollama**: Verify Ollama is running (`ollama list` in terminal) and has at least one model pulled
5. **Check model selection**: Ensure a model is selected in the LLM settings dropdown
6. **Custom endpoint**: the error names each path NexQ tried (`/chat/completions`, then `/api/chat`) and what the endpoint answered. `401 Unauthorized` means the token or key is wrong: paste it again under Settings > LLM > Custom, and it applies at once. `404` with "model not found" means the model name is wrong. For Ollama Cloud, use the base URL `https://ollama.com/v1`, **Bearer Token** and a model name such as `gemma4:31b`

### Ollama Not Detected

**Problem**: NexQ shows "Ollama not reachable" or no models appear.

**Solution**:

1. Verify Ollama is installed and running: open a terminal and run `ollama list`
2. If no models appear, pull one: `ollama pull llama3.2`
3. Ensure Ollama is serving on the default port: `http://localhost:11434`
4. Restart NexQ after starting Ollama -- auto-detection runs on startup

### AI Responses Slow

**Problem**: AI suggestions take a long time to appear, or responses stream very slowly.

**Solution**:

1. **Switch to a faster LLM provider.** Groq provides the fastest cloud inference with a free tier. See the [AI Providers Guide](ai-providers.md) for speed comparisons.
2. **Use a smaller local model.** If using Ollama, switch from a large model to a smaller one (e.g., llama3.2 3B instead of 8B).
3. **Check your internet connection.** Cloud providers require a stable connection. Slow or intermittent connections cause delayed responses.
4. **Reduce the context window.** In Settings, reduce the amount of transcript data sent to the LLM. Less input means faster responses.
5. **Close other resource-intensive applications.** Local LLMs compete with other apps for CPU/RAM.
6. **Automatic answers start 1.5 seconds after the question?** That's the quiet wait for engines that can end a line mid-sentence. Transcribe the other party with Cartesia or Deepgram Flux (Settings > STT Providers): both say when the speaker has finished, so Auto-Answer starts at once. With Flux, quiet time counts toward Deepgram usage, since NexQ streams silence to it; muted time doesn't.

## Workspaces, Chat and Live Helpers

### "Workspaces aren't available right now"

**Problem**: A note in the Library and at the top of the workspace says workspaces aren't available, and everything is in General.

**What happened**: The upgrade that adds workspaces didn't finish. It is all or nothing, so nothing was changed and NexQ works as it did before.

**Solution**:

1. Restart NexQ. It tries the upgrade again.
2. If the note stays, copy your log (**Settings > About > Diagnostics > Copy recent log**) and [report it](https://github.com/naxhq/NexQ/issues/new?template=bug_report.yml).
3. Don't delete `nexq-before-workspaces.db` in the app data folder. It is a copy of your data from before the upgrade, kept for 14 days.

### A Document or Folder Shows "Missing"

The file or folder moved or was deleted. Click **Remove** on its row, or put it back where it was. If it is a folder or tool, check **Settings > Personal Sources**: after a [settings reset](#settings-restored-or-reset) the list there may need to be filled again.

### A Folder Shows "Needs your OK to search its text"

NexQ doesn't search a folder until you allow it. Turn on **Search its text** under the folder. See [Workspaces](workspaces.md#folder-text-search).

### Workspace Chat Doesn't Find Something

- Check the answer's sources, and open **Context** to see what the answer saw.
- If it says "N things didn't fit", click **Search deeper**.
- A meeting you left out of the chat, a document you removed from the workspace, and anything in another workspace are not used. See [What is shared between workspaces](workspaces.md#what-is-shared-between-workspaces).
- A folder is only searched after **Search its text** is on. Files over 2 MB, hidden files and files with names like `.env` or containing `secret` or `password` are skipped.
- Very recent meetings are searched as soon as they are indexed. Indexing waits while a meeting is running, so a meeting you just finished may take a moment.

### Workspace Chat Says a Tool Is Off

Codex and Antigravity can't ask before a tool that changes something yet, so those tools are off in chat. With Claude, update the Claude command-line tool to version 2.1.328 or newer. API and local models can't use tools at all. See [Workspace chat](workspace-chat.md#tool-approval).

### "A live answer took priority"

A meeting is running, and its live answer needed the same local server (Ollama, LM Studio or a local custom server) as your chat answer. Click **Try again** when the live answer is done, or use another provider for the chat.

### The Meeting Window Lost a Panel

Open **Layout** in the meeting window and tick the panel under **Panels**. A hidden panel is not lost. **Reset to Classic** brings back the default arrangement. If **Layout locked** is on, unlock it first. See [Meeting window layout](meeting-layout.md).

### Follow My Voice Is Unavailable or Loses the Place

The panel says why when it is unavailable: an in-person meeting, a muted microphone, or no speech engine for your side. If it loses your place, scroll to where you are and it picks up again. See the [honest limits](talking-points.md#honest-limits).

### Live Notes or the Brief Paused

- **Keep taking notes?** or **Keep the brief going?** means the limit was reached. Choose **Keep going** or **Stop**. See [Live notes and the brief](live-notes-and-brief.md#cost-and-the-limit).
- **Notes paused** or **Notes stopped** with a reason means the model couldn't answer: a missing key, a plan limit or a server that isn't running. Click **Change model** or **Try again**.
- The brief says **The brief is turned off** or **The brief is off in this workspace** when it is off for the workspace. Turn it on in the Brief panel.

## Overlay Issues

### Overlay Not Showing

**Problem**: The overlay window does not appear when starting a meeting.

**Solution**:

1. **Verify a meeting is active.** The overlay only appears during an active meeting. Press `Ctrl+M` to start a meeting first.
2. Press `Ctrl+B` to toggle the overlay window
3. The overlay may be positioned off-screen. Try moving it by checking the taskbar for the "NexQ Overlay" entry
4. Check Windows taskbar for a second NexQ window entry -- the overlay might be minimized
5. Restart NexQ -- the overlay resets to position (50, 50) on startup

### Overlay Not Staying on Top

**Problem**: The overlay disappears behind other windows.

**Solution**:

- The overlay is configured as always-on-top by default. If it is not staying on top, some full-screen applications may override this behavior
- Try running your meeting application in windowed mode instead of full-screen
- Check that no other always-on-top application is competing for the topmost position

## Performance Issues

### High CPU Usage

**Problem**: NexQ is using excessive CPU, causing system slowdown.

**Solution**:

- **Local Whisper STT** is the most common cause. Switch to a cloud STT provider (Web Speech API, Deepgram, or Groq) to reduce CPU usage significantly
- **Local LLM** (Ollama with large models) can also be CPU-intensive during generation. Consider using a cloud LLM provider for lower resource usage
- Close the AI Call Log sidebar if you do not need real-time call debugging
- Reduce the context window duration in Settings to send less transcript data to the LLM

### High Memory Usage

**Problem**: NexQ memory usage grows over time during long meetings.

**Solution**:

- Long meetings accumulate transcript segments in memory. This is expected behavior
- End and restart meetings periodically for very long sessions (4+ hours)
- Remove documents you no longer need from the Library of your workspaces
- If using local RAG, the embedding index consumes memory proportional to document size

## Data and Storage

### Where Is My Data Stored?

NexQ stores all data in the app data directory:

```
%APPDATA%\com.nexq.app\
```

On macOS: `~/Library/Application Support/com.nexq.app/`

This includes:
- SQLite database `nexq.db` (workspaces, meetings, transcripts, chats, notes, AI interactions)
- `nexq-before-workspaces.db`, a safety copy made once when you first upgraded to workspaces. It is deleted after 14 days ([details](workspaces.md#what-happens-when-you-upgrade))
- Settings files: `config.json`, `nexq-settings.json` and `translation-config.json`, each with a `.bak` copy
- Downloaded STT models (`models/` subdirectory)
- Audio recordings (if recording is enabled)
- RAG index and embeddings

### Settings Restored or Reset

**Problem**: After starting NexQ, a notice says **Settings restored** or **Some settings were reset**.

**What happened**: NexQ checks its settings files each time it starts. If a file can't be read (for example the PC lost power while it was being written), NexQ never silently replaces it with defaults.

- It moves the damaged file aside as `config.json.corrupt-` followed by a number (the same for the other two files). The newest three are kept.
- If it has a good copy (`config.json.bak`, refreshed from a valid file at start and about every 10 minutes), it puts that back. The notice says **Settings restored** and "NexQ put back the last good copy". You may lose changes from the last few minutes.
- If there is no good copy, that file starts from the defaults. The notice says **Some settings were reset**, and tells you which settings: your settings (`config.json`), your update preferences or your translation settings. You may see the first-run setup again.

The notice names the damaged file and stays until you close it.

**Solution**:

- If settings were restored, check that the provider, speech engine and hotkeys are what you expect.
- If they were reset, set up your provider and speech engine again. API keys are kept in the Windows Credential Manager, not in these files, so they are not lost.
- Your notes folders and tools may show as **Missing** in a workspace's Library until you add them again. Their place in your workspaces is kept.
- Keep the `.corrupt-` file until you are sure nothing is missing. If a problem repeats, [report it](https://github.com/naxhq/NexQ/issues/new?template=bug_report.yml) with your log.

### API Keys

API keys are stored in **Windows Credential Manager**, not in files. You can view or remove them through Windows Settings > Credential Manager, or through NexQ's Settings panel.

## Collecting Logs for a Bug Report

NexQ (v2.27 and later) writes a log file on your computer. It records what the app did: audio devices opened, STT connections, errors, and how many transcript lines each side produced. It never contains your transcript text, and API keys are removed automatically.

### Quick way: copy the recent log

1. Open **Settings → About → Diagnostics**.
2. Click **Copy recent log**.
3. Paste it into the **Logs** field of the [bug report](https://github.com/naxhq/NexQ/issues/new?template=bug_report.yml).

### Attach the whole file

Click **Open log folder** in the same section, then drag `nexq.log` into the bug report. The folder is:

| Windows | macOS |
|---|---|
| `%LOCALAPPDATA%\com.nexq.app\logs\` | `~/Library/Logs/com.nexq.app/` |

Older logs are kept as `nexq.1.log` to `nexq.4.log`; the folder never grows past about 20 MB.

### For hard-to-reproduce problems

1. Turn on **Verbose logging** in Settings → About → Diagnostics.
2. Reproduce the problem (for example, start a meeting and talk for 30 seconds).
3. Copy the recent log or attach `nexq.log`, then turn verbose logging off again.

### During a meeting

The **Dev Log** shows the same STT and audio messages live: press `Ctrl+Shift+L` in the meeting window (or click the terminal icon). A screenshot of it helps when the log file isn't available, for example on versions before v2.27.

Glance over a log before posting it publicly: file names, device names and provider error messages can appear in it.

## Still Need Help?

If your issue is not covered here, these guides may help:

- [Audio Setup Guide](audio-setup.md) -- Detailed audio device configuration and troubleshooting
- [AI Providers Guide](ai-providers.md) -- Provider setup, comparison, and configuration
- [Using Context Intelligence (RAG)](rag-context.md) -- Document loading and indexing issues
- [Workspaces](workspaces.md) -- Workspaces, the Library and the upgrade
- [Workspace Chat](workspace-chat.md) -- Questions across meetings and files
- [Getting Started](getting-started.md) -- Initial setup walkthrough
