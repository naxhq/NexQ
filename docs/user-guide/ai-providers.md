# Choosing AI Providers

NexQ uses two types of AI providers: **Speech-to-Text (STT)** for transcription and **Large Language Models (LLM)** for AI assistance. This guide compares all available providers and helps you choose the right ones for your use case.

## STT Provider Comparison

![STT Providers settings panel](../../website/public/screenshots/Setting/Setting-STT%20Providers.png)

NexQ supports 12 STT providers. Each channel ("You" and "Them") can use a different provider.

| Provider | Type | Cost | Accuracy | Speed | Best For |
|----------|------|------|----------|-------|----------|
| Web Speech API | Built-in, online (no key) | Free | Good | Real-time | Quick setup, long sessions, English |
| Deepgram | Cloud | Pay per use | Excellent | Real-time | Production use, high accuracy; Flux knows when a speaker finishes |
| Groq Whisper | Cloud | Free tier | Very Good | Very Fast | High accuracy at no cost |
| [Whisper API](#custom-whisper-endpoint-local-servers) | Cloud or self-hosted | OpenAI pricing / free self-hosted | Very Good | Batched (~5 s) | OpenAI or your own compatible server |
| Cartesia | Cloud | Pay per second | Very Good | Real-time | Lines that end when the speaker finishes (English, French, Hindi, Japanese, Spanish) |
| Whisper (local) | Local | Free | Excellent | Slow | Privacy, offline use |
| ONNX Runtime | Local | Free | Good | Medium | Balanced local option |
| Sherpa-ONNX | Local | Free | Good | Medium | Lightweight local option |
| ORT Streaming | Local | Free | Good | Medium | Streaming local inference |
| Parakeet TDT | Local | Free | Very Good | Medium | High-quality local option |
| Azure Speech | Cloud | Pay per use | Excellent | Batched (~5s) | Existing Azure Speech REST transcription |
| Azure MAI Streaming | Cloud | [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/speech/) | Not yet rated (preview) | Real-time streaming | Multilingual live transcription; interim updates and Azure finals |
| Windows Speech | Built-in, online (no key) | Free | Fair | Real-time | No-key fallback for your mic on Windows |

**Azure Speech** and **Azure MAI Streaming** are separate providers. Azure Speech remains the REST-based, batched option; Azure MAI Streaming uses Microsoft's `mai-transcribe-2-streaming` model for live incremental transcripts. See [Azure MAI Streaming setup](#azure-mai-streaming-public-preview) below.

### Choosing an STT Provider

**Start with Web Speech API** if you want zero-setup transcription. It works out of the box, costs nothing, and handles long sessions well.

**Use Deepgram or Groq** if you need higher accuracy. Deepgram's Nova-3 model is the most accurate real-time option. Groq offers excellent accuracy on a free tier. If you rely on **Auto-Answer**, choose Deepgram's **Flux** model (Settings > STT Providers > Deepgram > Model): Flux decides when a speaker has finished, so NexQ answers a question as soon as it's asked instead of waiting 1.5 seconds of quiet, and can start on a likely finish. Choose **Flux** for English or **Flux Multilingual** for English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian and Dutch. Flux doesn't tell speakers apart, so in-person meetings on Flux show a single "Room" speaker. NexQ streams silence to Flux, which needs it to hear where a turn ends, so quiet time counts toward your Deepgram usage; with Nova, NexQ skips long silence. Muting a channel closes its Flux stream, so muted time costs nothing.

**Use Cartesia** if you want each transcript line to end where the speaker actually finishes a thought. Cartesia's ink-2 model decides where each turn ends from what is being said, not only from pauses. It transcribes English, French, Hindi, Japanese and Spanish, and detects which one is spoken. Cartesia bills every second of audio it receives while a channel is unmuted, silence included: about 3 credits per second for each channel that uses it. Muting a channel closes its Cartesia stream, so muted time costs nothing. To halve the cost, use Cartesia for "Them" and Web Speech for "You".

**Use a local provider** if privacy is critical or you need offline capability. Whisper with the large-v3 model provides the best local accuracy, but requires significant CPU/RAM. Smaller models (tiny, base) are faster but less accurate.

**For Ukrainian transcription**, select **Ukrainian** under Settings > STT Providers > Transcription language. For offline transcription, use Parakeet TDT 0.6B v3 or a multilingual Whisper.cpp model such as Whisper Small. Cloud options include Deepgram Nova-3, Azure Speech, Azure MAI Streaming, Groq Whisper, and the OpenAI Whisper API. Start a new meeting after changing the language. A side with its own language (see [A different language for each side](#a-different-language-for-each-side)) ignores this setting.

**For Vietnamese transcription**, select **Vietnamese** under Settings > STT Providers > Transcription language. Deepgram Nova-3, Azure Speech, Azure MAI Streaming, and multilingual Whisper models support Vietnamese; choose a model that supports the language for each channel. The included Parakeet models do not support Vietnamese. A language change takes effect when the STT provider reconnects, so start a new meeting after changing it. A side with its own language ignores this setting.

**To detect the spoken language**, choose **Auto-detect** under Settings > STT Providers > Transcription language or Audio & Devices > Transcription language. Choose a provider that can detect the language for each side set to Auto-detect: Deepgram Nova-3 or Flux Multilingual, Azure MAI Streaming, Parakeet TDT 0.6B v3, Groq Whisper, Whisper API, or Cartesia. The languages detected depend on the model. Start a new meeting after changing the language.

These can't detect the language: Web Speech, Windows Speech, Azure Speech, Sherpa-ONNX, ORT Streaming and Parakeet CTC 110M. If a side set to Auto-detect uses one, NexQ shows a warning in settings, and when a meeting starts that side isn't transcribed (a mid-meeting switch to one of them is refused, except for Web Speech, which stops with a notice). Pick a language or change the provider for that side.

**For speech that switches languages mid-sentence**, such as Ukrainian with English technical terms, use **Deepgram Nova-3** with **Auto-detect**. This combination enables [Nova-3 multilingual transcription](https://developers.deepgram.com/docs/nova-3-language-prompting), which Deepgram bills at a higher rate than single-language Nova-3 (see [Deepgram's pricing](https://deepgram.com/pricing)).

**Which engines cover which languages:** Parakeet TDT 0.6B v3 covers 25 European languages (including Ukrainian and Russian, not Chinese, Japanese, Korean, Hindi, Arabic or Turkish). Deepgram Flux is English only; Flux Multilingual covers English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian and Dutch. Azure MAI Streaming supports multilingual auto-detection and explicit supported locales; see [Microsoft's language list](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming). Parakeet CTC 110M, ORT Streaming, the English Sherpa-ONNX zipformers and the `.en` and Distil Whisper.cpp models are English only. Of the other Sherpa-ONNX models, the Chinese/Multilingual zipformer covers Chinese only (not English) and SenseVoice Small covers Chinese, English, Japanese and Korean. For Chinese, use Deepgram Nova-3, a multilingual Whisper model, Azure Speech, Azure MAI Streaming, or Sherpa-ONNX SenseVoice Small.

### Custom Whisper endpoint (local servers)

The **Whisper API** provider can send audio to any server that speaks OpenAI's `/v1/audio/transcriptions` API instead of OpenAI, for example [faster-whisper-server / Speaches](https://github.com/speaches-ai/speaches) or a wrapper around another speech model. Only the audio goes to the server you choose, so a server on your own machine keeps it off the internet.

1. Open Settings > STT Providers and choose **Whisper API**.
2. Under **Endpoint**, enter the server's base URL, for example `http://127.0.0.1:8000/v1`. A pasted `.../audio/transcriptions` URL is trimmed for you. It must start with `http://` or `https://`.
3. Under **Model**, enter the model name the server expects, for example `Systran/faster-whisper-small`.
4. Leave the key field empty if the server needs none, then click **Save & Test**.

What to know:

- **Your OpenAI key stays separate.** With an endpoint set, the key field is "API key for this server (optional)" and is saved on its own. The OpenAI key is never sent to a custom server. Clear the Endpoint field to go back to OpenAI and your saved OpenAI key.
- **Empty means OpenAI.** With Endpoint and Model empty, NexQ uses `https://api.openai.com/v1` and `whisper-1`, which needs an OpenAI key. You can also set only **Model** (for example `gpt-4o-transcribe`) to stay on OpenAI with another model.
- **Not live streaming.** Whisper API sends the audio in batches of about 5 seconds, so text appears a few seconds after it is spoken. For word-by-word text, use Deepgram, Cartesia or a local streaming engine.
- **Save & Test** sends half a second of silence to the server's transcription endpoint, so a server that can't transcribe fails the test instead of passing it.
- **`http://` to another machine** sends the key unencrypted. NexQ warns about it when a key is set. Use `https://` or keep the server on this computer.

### Azure MAI Streaming (public preview)

**Azure MAI Streaming** is a separate provider (`azure_mai_streaming`) that uses Microsoft's `mai-transcribe-2-streaming` model. It is not the existing **Azure Speech** provider (`azure_speech`), which still sends short audio batches to the Azure Speech REST API. The new provider uses the [official Azure Speech SDK for JavaScript](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming-speech-sdk), bundled with NexQ; you do not need to install Node.js, the SDK, or another runtime.

The model streams **interim** text that updates while someone is speaking, followed by Azure **final** results for confirmed segments. It defaults to multilingual language auto-detection; you can instead set an explicit supported locale for each side. It does **not** diarize speakers. NexQ still keeps your microphone ("You") and system audio ("Them") on separate channels, but this provider will not identify multiple speakers within one channel. This model is in public preview; Microsoft currently notes that preview features have no SLA and are not recommended for production workloads. Check Microsoft's [overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming) for current availability and preview limitations.

#### Set up Azure MAI Streaming

1. Open the [Azure portal](https://portal.azure.com/), then go to [Azure AI Services Resources](https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts).
2. Create a **Speech** resource in one of the model's supported serving regions: `swedencentral`, `centralus`, `eastus2`, or `southeastasia`. See Microsoft's [serving-region information](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming#availability-and-regions).
3. Open the resource's **Keys and Endpoint** page. Copy a Speech resource key and note its region identifier. The key and region must come from the same resource.
4. In NexQ, open **Settings > STT Providers**, select **Azure MAI Streaming**, enter the key and region, then click **Save & Test**.
5. In **Settings > Audio & Devices**, choose **Azure MAI Streaming** for **You**, **Them**, or both. Set each side's language to **Auto-detect** or to a supported locale.

The [Azure Speech SDK integration](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming-speech-sdk) is the path NexQ uses. Microsoft's separate [Foundry Realtime API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe-2-streaming-realtime) uses an OpenAI-compatible WebSocket integration and requires a Foundry model deployment. You do **not** need to create a Foundry deployment or configure that Realtime API to use Azure MAI Streaming in NexQ.

#### Verify live transcription

- In a test meeting, speak into the selected microphone and play speech through the selected system-audio device. Check each side you configured.
- Confirm interim words update as you speak and Azure final results settle into the transcript.
- Try **Auto-detect**, then an explicit supported locale if you want to compare.
- If multiple people share a channel, expect their words to appear without Azure speaker labels; diarization is not supported.

### A different language for each side

When you and the others speak different languages, give each side its own. Open **Settings > Audio & Devices** and use the **Language** menu on each card: **You**, **Them**, or **Room** in an in-person meeting. The menu starts on **Default** (it names the current transcription language), which follows the shared **Transcription language** (Settings > STT Providers, and at the top of Audio & Devices), so nothing changes until you pick one.

For example, if you speak English and the others speak Spanish, leave You on **Default** (English) and set Them to **Spanish**. Each side's provider then listens in its own language. A side can also be set to **Auto-detect**, which needs a provider that can detect the language (see the list above); the other side keeps its own language.

Changing a side's language during a meeting briefly restarts transcription, the same as changing a provider, so you don't need to start a new meeting. The language hints on each card (for example, Flux doesn't transcribe Ukrainian) follow that side's own language.

## LLM Provider Comparison

![LLM Providers settings panel](../../website/public/screenshots/Setting/Setting-LLM%20Providers.png)

NexQ supports 9 LLM providers. The LLM powers all AI features: Assist, What to Say, Shorten, Follow-Up, Recap, Ask Question, Meeting Summary, and Action Items.

| Provider | Type | Cost | Speed | Best For |
|----------|------|------|-------|----------|
| Ollama | Local | Free | Varies by model | Privacy, free, offline |
| OpenAI | Cloud | Pay per use | Fast | Best overall quality |
| Anthropic | Cloud | Pay per use | Fast | Nuanced, detailed responses |
| Groq | Cloud | Free tier | Very Fast | Speed, free tier |
| Google Gemini | Cloud | Free tier | Fast | Long context, multimodal |
| LM Studio | Local | Free | Varies by model | Local with GUI model management |
| OpenRouter | Cloud | Pay per use | Varies | Access to hundreds of models |
| Claude (subscription, Beta) | Local CLI | Included in your Claude plan | Fast | Using your own Claude Pro/Max login, no API key |
| Antigravity (subscription, Beta) | Local CLI | Included in your Google AI plan | Fast | Gemini (and other) models through your Google login, no API key |
| Codex (subscription, Beta) | Local CLI | Included in your ChatGPT plan | Fast | OpenAI models through your ChatGPT login, no API key |
| Custom | Configurable | Varies | Varies | Self-hosted or custom endpoints |

### Choosing an LLM Provider

**Start with Ollama** if you want free, private AI assistance. Install Ollama, pull a model, and NexQ connects automatically.

**Use OpenAI (GPT-4o)** if you want the best quality suggestions. GPT-4o provides the most accurate and contextually aware responses.

**Use Groq** if you want the fastest responses at no cost. Groq's free tier with Llama models provides fast inference with good quality.

**Use Claude (subscription, Beta)** if you already pay for Claude Pro or Max and want to use it without an API key. See the [Claude subscription guide](claude-subscription.md).

**Use Antigravity or Codex (subscription, Beta)** the same way if you pay for Google AI or ChatGPT. Install the CLI (Antigravity from antigravity.google, Codex with `npm i -g @openai/codex`), sign in once with the Log in button in Settings > LLM Providers, then pick Fast and Deep models there. NexQ fetches each CLI's current model list every time it starts. Notes folders and MCP servers from Personal Sources work with all three. Antigravity and Codex read your notes only through NexQ's own read-only notes tool, and they can't run commands, write files or search the web. Image attachments still need Claude.

**Use Anthropic (Claude)** if you prefer nuanced, well-reasoned responses, especially for complex or sensitive topics.

### Choosing a model for chat, notes and the brief

Live answers use the provider you set above. Three newer features can use a different one, so a slow, careful model for questions doesn't have to answer live:

- **[Workspace chat](workspace-chat.md)** has a **Model** picker in each chat. A new chat starts on your active provider and model (on your **Deep** model if the provider is a subscription).
- **[Live notes and the brief](live-notes-and-brief.md)** have their own **Model** in **Settings > Live Notes and Brief**. The default, **Automatic**, is the cheapest model of your active provider.
- **[Memory suggestions](talking-points.md#memory)** have their own model too, also **Automatic** by default.

None of them switches to another provider if yours fails. They say what failed and let you choose. A live answer always goes first: on a local server (Ollama, LM Studio or a local custom server) it can stop a chat answer or hold back notes that use the same server.

Only the subscription providers (Claude, Codex, Antigravity) can read folders and use tools in a chat. Claude asks before a tool that could change something (version 2.1.328 or newer); Codex and Antigravity can't ask yet, so those tools are off for them. API and local models answer from the passages NexQ finds and can't use tools.

## Local vs Cloud Tradeoffs

| Factor | Local (Ollama, Whisper, LM Studio) | Cloud (OpenAI, Deepgram, Groq) |
|--------|--------------------------------------|--------------------------------|
| **Privacy** | Data never leaves your machine | Data sent to provider servers |
| **Cost** | Free | Free tier or pay per use |
| **Setup** | Download and install models | Enter an API key |
| **Accuracy** | Good to Excellent (model dependent) | Excellent |
| **Speed** | Depends on hardware | Consistently fast |
| **Offline** | Works without internet | Requires internet |
| **Resource Usage** | High CPU/RAM during inference | Minimal local resources |

**Recommendation**: Use cloud providers for the best experience. Switch to local if privacy is a hard requirement or you need offline capability.

## Setting Up Ollama (Local LLM)

Ollama is the easiest way to run a local LLM. NexQ auto-detects it on startup.

1. Download and install Ollama from [ollama.ai](https://ollama.ai)
2. Open a terminal and pull a model:
   ```
   ollama pull llama3.2
   ```
3. Verify the model is available:
   ```
   ollama list
   ```
4. Launch NexQ -- it auto-detects Ollama at `http://localhost:11434`
5. Open Settings > LLM to verify the connection and select your model

### Recommended Ollama Models

| Model | Size | Quality | Speed | Use Case |
|-------|------|---------|-------|----------|
| llama3.2 (3B) | ~2 GB | Good | Fast | Quick responses, lower-end hardware |
| llama3.1 (8B) | ~4.7 GB | Very Good | Medium | Best balance of quality and speed |
| mistral (7B) | ~4 GB | Very Good | Medium | Strong general-purpose performance |
| gemma2 (9B) | ~5.4 GB | Very Good | Medium | Good for summarization |

## Setting Up Local Whisper (Local STT)

Local Whisper provides high-accuracy transcription without sending audio to the cloud.

1. Open Settings > Speech-to-Text
2. Select a local engine: **whisper.cpp**, **Sherpa-ONNX**, **ORT Streaming**, or **Parakeet TDT**
3. Click **Download Model** and choose a model size:

| Model | Size | Accuracy | Speed | RAM Required |
|-------|------|----------|-------|-------------|
| tiny | ~75 MB | Fair | Very Fast | ~1 GB |
| base | ~150 MB | Good | Fast | ~1 GB |
| small | ~500 MB | Good | Medium | ~2 GB |
| medium | ~1.5 GB | Very Good | Slow | ~4 GB |
| large-v3 | ~3 GB | Excellent | Very Slow | ~8 GB |

4. Wait for the download to complete
5. Select the model in the STT provider dropdown
6. Test with the audio level meters to verify transcription

**Tip**: Start with the `small` model for a good balance of accuracy and speed. Move to `large-v3` if accuracy is critical and your hardware can handle it.

## Setting Up Cloud Providers (API Keys)

All cloud providers require an API key. Here is where to get them:

| Provider | Get API Key | Dashboard |
|----------|-------------|-----------|
| Deepgram | [deepgram.com](https://deepgram.com) | Console > API Keys |
| Groq | [groq.com](https://groq.com) | Console > API Keys |
| Cartesia | [play.cartesia.ai](https://play.cartesia.ai/keys) | API Keys |
| OpenAI | [platform.openai.com](https://platform.openai.com) | API Keys |
| Anthropic | [console.anthropic.com](https://console.anthropic.com) | API Keys |
| Google Gemini | [aistudio.google.com](https://aistudio.google.com) | Get API Key |
| OpenRouter | [openrouter.ai](https://openrouter.ai) | Keys |
| Azure Speech | [portal.azure.com](https://portal.azure.com) | Cognitive Services > Speech |
| Azure MAI Streaming | [Azure portal](https://portal.azure.com/) | Speech resource > Keys and Endpoint; see [setup steps](#set-up-azure-mai-streaming) |

### Entering API Keys in NexQ

1. Open Settings (`Ctrl+,`)
2. Navigate to the provider section (STT or LLM)
3. Select the provider from the dropdown
4. Paste your API key into the API Key field
5. Click **Test Connection** to verify
6. The key is stored securely in **Windows Credential Manager** -- not in config files or plain text

### API Key Security

- Keys are stored in Windows Credential Manager, scoped to your Windows user account
- Keys persist across app updates
- To remove a key: Settings > Provider > Remove API Key
- You can also manage keys through Windows Settings > Credential Manager

## Any OpenAI-compatible API (DeepSeek example)

The Custom provider talks to any service that follows the OpenAI API, not only local servers. DeepSeek is one example:

1. Open Settings > LLM Providers and choose **Custom**.
2. Set **Base URL** to `https://api.deepseek.com`. NexQ adds `/chat/completions` and `/models` itself, so don't include them.
3. Set **Auth Type** to **Bearer Token** and paste your API key into the **Token** field. Cloud APIs refuse requests without it (a 401 or 403 from **Test Connection** usually means this is wrong).
4. Click **Test Connection**, then **Load Models** and pick a model from the list.
5. Click **Use Custom for AI responses**.

The same steps work for other OpenAI-compatible services: use the base URL from the service's documentation. If you would rather use one key for many models, choose the **OpenRouter** provider instead of Custom.

## Tips

- **Mix and match providers.** You can use different STT providers for "You" and "Them" channels, and a different LLM provider for AI assistance. For example: Web Speech API for mic, Deepgram for system audio, and Ollama for LLM.
- **Start with free options.** Web Speech API (STT) + Ollama (LLM) gives you a fully functional setup at zero cost.
- **Test connection before meetings.** Always click Test Connection after setting up a new provider to catch configuration issues early.
- **Monitor usage for paid providers.** Cloud providers charge per use. Check your dashboard regularly to avoid unexpected costs.
- **Groq offers free tiers for both STT and LLM.** This is the best option if you want cloud accuracy without paying.

## Next Steps

- [Audio Setup Guide](audio-setup.md) -- Configure audio devices for optimal capture
- [Using Context Intelligence (RAG)](rag-context.md) -- Enhance AI responses with your documents
- [Configuration Guide](configuration.md) -- Detailed provider configuration options
- [Getting Started](getting-started.md) -- Quick setup walkthrough
