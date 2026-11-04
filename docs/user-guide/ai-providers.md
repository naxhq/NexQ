# Choosing AI Providers

NexQ uses two types of AI providers: **Speech-to-Text (STT)** for transcription and **Large Language Models (LLM)** for AI assistance. This guide compares all available providers and helps you choose the right ones for your use case.

## STT Provider Comparison

![STT Providers settings panel](../../website/public/screenshots/Setting/Setting-STT%20Providers.png)

NexQ supports 11 STT providers. Each channel ("You" and "Them") can use a different provider.

| Provider | Type | Cost | Accuracy | Speed | Best For |
|----------|------|------|----------|-------|----------|
| Web Speech API | Browser | Free | Good | Real-time | Quick setup, long sessions, English |
| Deepgram | Cloud | Pay per use | Excellent | Real-time | Production use, high accuracy; Flux knows when a speaker finishes |
| Groq Whisper | Cloud | Free tier | Very Good | Very Fast | High accuracy at no cost |
| Cartesia | Cloud | Pay per second | Very Good | Real-time | Lines that end when the speaker finishes (English, French, Hindi, Japanese, Spanish) |
| Whisper (local) | Local | Free | Excellent | Slow | Privacy, offline use |
| ONNX Runtime | Local | Free | Good | Medium | Balanced local option |
| Sherpa-ONNX | Local | Free | Good | Medium | Lightweight local option |
| ORT Streaming | Local | Free | Good | Medium | Streaming local inference |
| Parakeet TDT | Local | Free | Very Good | Medium | High-quality local option |
| Azure Speech | Cloud | Pay per use | Excellent | Real-time | Enterprise, multi-language |
| Windows Native | Local | Free | Fair | Real-time | Offline fallback |

### Choosing an STT Provider

**Start with Web Speech API** if you want zero-setup transcription. It works out of the box, costs nothing, and handles long sessions well.

**Use Deepgram or Groq** if you need higher accuracy. Deepgram's Nova-3 model is the most accurate real-time option. Groq offers excellent accuracy on a free tier. If you rely on **Auto-Answer**, choose Deepgram's **Flux** model (Settings > STT Providers > Deepgram > Model): Flux decides when a speaker has finished, so NexQ answers a question as soon as it's asked instead of waiting 1.5 seconds of quiet, and can start on a likely finish. Choose **Flux** for English or **Flux Multilingual** for English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian and Dutch. Flux doesn't tell speakers apart, so in-person meetings on Flux show a single "Room" speaker. NexQ streams silence to Flux, which needs it to hear where a turn ends, so quiet time counts toward your Deepgram usage; with Nova, NexQ skips long silence. Muting a channel closes its Flux stream, so muted time costs nothing.

**Use Cartesia** if you want each transcript line to end where the speaker actually finishes a thought. Cartesia's ink-2 model decides where each turn ends from what is being said, not only from pauses. It transcribes English, French, Hindi, Japanese and Spanish, and detects which one is spoken. Cartesia bills every second of audio it receives while a channel is unmuted, silence included: about 3 credits per second for each channel that uses it. Muting a channel closes its Cartesia stream, so muted time costs nothing. To halve the cost, use Cartesia for "Them" and Web Speech for "You".

**Use a local provider** if privacy is critical or you need offline capability. Whisper with the large-v3 model provides the best local accuracy, but requires significant CPU/RAM. Smaller models (tiny, base) are faster but less accurate.

**For Vietnamese transcription**, select **Vietnamese** under Settings > STT Providers > Language. Deepgram Nova-3, Azure Speech, and multilingual Whisper models support Vietnamese; choose a model that supports the language for each channel. The included Parakeet models do not support Vietnamese. A language change takes effect when the STT provider reconnects, so start a new meeting after changing it.

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
| Custom | Configurable | Varies | Varies | Self-hosted or custom endpoints |

### Choosing an LLM Provider

**Start with Ollama** if you want free, private AI assistance. Install Ollama, pull a model, and NexQ connects automatically.

**Use OpenAI (GPT-4o)** if you want the best quality suggestions. GPT-4o provides the most accurate and contextually aware responses.

**Use Groq** if you want the fastest responses at no cost. Groq's free tier with Llama models provides fast inference with good quality.

**Use Claude (subscription, Beta)** if you already pay for Claude Pro or Max and want to use it without an API key. See the [Claude subscription guide](claude-subscription.md).

**Use Anthropic (Claude)** if you prefer nuanced, well-reasoned responses, especially for complex or sensitive topics.

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
