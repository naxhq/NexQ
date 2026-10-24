# Audio Setup Guide

NexQ uses a dual-party audio model to capture and transcribe both sides of a conversation independently. This guide covers how audio capture works, how to configure your devices, and how to troubleshoot common audio issues.

## How Dual-Party Audio Works

NexQ captures two independent audio streams:

- **"You" channel** -- your microphone, capturing your voice
- **"Them" channel** -- system output capture (WASAPI on Windows, Core Audio taps on macOS 14.2+), capturing remote participants

Each channel has its own:
- Audio device selection
- STT provider (can use different providers for each)
- Mute control (pauses transcription without stopping audio capture)
- Audio level meter (for real-time monitoring)

This separation ensures clean transcription with accurate speaker labels.

## Audio Device Settings

![Audio and Devices settings panel](../../website/public/screenshots/Setting/Setting-Audio%20and%20Devices.png)

The Audio and Devices settings panel provides controls for selecting and testing both input and output devices, configuring recording options, and monitoring audio levels in real-time.

## Selecting Your Microphone

### Configuration

1. Open Settings (`Ctrl+,`) > Audio
2. Under **"You" (Microphone)**, select your input device from the dropdown
3. Choose the input entry for your microphone; an audio interface can also appear as a separate output entry with the same name
4. Click **Test** to verify -- the live peak meter should respond when you speak

### Choosing the Right Microphone

- **Built-in laptop mic** -- works for casual use but picks up ambient noise
- **USB headset mic** -- best for meetings. Reduces echo and background noise
- **External USB microphone** -- best for lecture recording or quiet environments
- **Bluetooth headset** -- works, but may introduce slight audio latency

### Checking Microphone Levels

If the level meter barely moves when you speak:

1. Open **Windows Settings > System > Sound > Input**
2. Select your microphone and increase the **Input volume**
3. Return to NexQ and test again
4. The meter should show clear peaks when you speak at a normal volume

## System Audio Capture

### How It Works

NexQ records the audio playing through your selected output device, including Zoom, Teams, Google Meet, and other applications.

- **Windows 10 and 11:** native WASAPI loopback.
- **macOS 14.2 and later:** a native Core Audio tap on the selected output. The input and output of the same audio interface remain independent.
- **No virtual cable required** on these platforms.
- **macOS permissions:** grant NexQ microphone and system-audio recording access in **System Settings > Privacy & Security**. Reopen NexQ if macOS requests it.
- **Older macOS:** native output capture is unavailable. A virtual loopback device exposed as an input can be selected instead.

### Configuration

1. Open Settings > Audio
2. Under **"Them" (System Audio)**, select the output device your meeting app plays audio through
3. Click **Test** -- the meter should respond when remote participants speak or when any audio plays through that device

### Which Output Device to Select

Select the device that your conferencing app (Zoom, Teams, etc.) uses for audio output:

- **Speakers** -- if you use external speakers (not recommended for meetings due to echo)
- **Headphones / headset** -- the best choice. NexQ captures the audio stream even though it goes to your headphones
- **Default output device** -- if unsure, this is usually correct

You can verify by playing audio through your meeting app and checking that the "Them" level meter in NexQ responds.

## Transcription on macOS

Audio capture and speech recognition are separate. Choose a provider for **each** party:

- **Local Parakeet TDT:** download the model once, then select it for both "You" and "Them". It consumes each selected native audio stream without an API key.
- **Cloud providers:** configure their API key before starting capture.
- **Web Speech:** depends on the embedded browser's speech service and may return `service-not-allowed` on macOS. It is not a replacement for selected-output capture.

The bundled Parakeet TDT export transcribes utterances after a pause, or splits continuous audio at roughly 20 seconds. Model processing adds latency; an active level meter does not imply an immediate transcript.

## Recording

NexQ can record meeting audio alongside the live transcript.

### Enabling Recording

1. Open Settings > Audio
2. Toggle **Recording** on
3. Recordings are saved as WAV files in the app data directory (`%APPDATA%\com.nexq.app\`)

### Playback

- Open a past meeting from the meeting history in the Launcher
- Use the playback controls to replay audio with the synced transcript
- Jump to specific moments using bookmarks or topic sections

## Common Audio Issues

### No System Audio Detected

**Problem**: The "Them" level meter shows no activity, even though you can hear remote participants.

**Solution**:

1. Verify you selected the correct **output device** in NexQ -- it must match the device your meeting app plays audio through
2. Check the output used by your meeting app in **Windows Settings > System > Sound** or **macOS System Settings > Sound > Output**
3. On macOS, check microphone and system-audio recording permissions in **System Settings > Privacy & Security**
4. If startup fails, read the error notification; NexQ does not silently substitute the microphone for an unavailable output

### Microphone Too Quiet

**Problem**: The "You" level meter barely moves, or transcription misses words.

**Solution**:

1. Open **Windows Settings > System > Sound > Input**
2. Select your microphone and increase the **Input volume** slider
3. If the slider is already at maximum, check your microphone's physical gain control (if it has one)
4. Try moving closer to the microphone
5. Switch to a USB headset or external microphone for better sensitivity

### Echo or Feedback

**Problem**: Your own voice appears in the "Them" transcript, or you hear echo.

**Solution**:

- **Use headphones.** This is the most effective fix. Speakers feed your voice back into the system audio loopback.
- Select an **input** for "You" and an **output** for "Them". Both may belong to the same audio interface; choosing its input twice intentionally duplicates the microphone.
- Enable echo cancellation in your meeting app (Zoom, Teams, etc.)

### Wrong Audio Device Selected

**Problem**: NexQ is capturing audio from the wrong device.

**Solution**:

1. Open Settings > Audio
2. Review both the "You" and "Them" device selections
3. Use the **Test** button for each device to verify which one responds to audio
4. If you recently plugged in or unplugged audio devices, the device list may need to refresh -- close and reopen Settings

### Audio Cuts Out During Long Meetings

**Problem**: Transcription stops or audio capture pauses during extended sessions.

**Solution**:

- Check that your system is not entering sleep mode during the meeting (Windows Settings > System > Power & Sleep)
- For USB audio devices, disable USB selective suspend in Power Options
- Web Speech API handles long sessions best -- consider switching to it for extended meetings
- If the issue persists, end and restart the meeting to reinitialize audio capture

## Noise and Audio Quality

![Noise Preset settings panel](../../website/public/screenshots/Setting/Setting-Noise%20Preset.png)

NexQ includes noise preset configurations to optimize audio quality for transcription. Select an environment preset that matches your meeting conditions (quiet room, office, cafe) to improve STT accuracy. Noise reduction and voice activity detection settings help filter out background noise and ensure clean audio reaches the transcription engine.

## Tips

- **Always test before important meetings.** Use the Test buttons in Settings > Audio to verify both channels before starting.
- **Use headphones for meetings.** This prevents echo and gives you cleaner "Them" channel transcription.
- **Check device selection after plugging in new devices.** Windows may change the default device, which can affect NexQ's audio capture.
- **For virtual meetings**, NexQ captures system audio from any app -- Zoom, Teams, Google Meet, Discord, or even a phone call played through speakers.
- **Muting a channel** pauses STT transcription for that source but does not stop audio capture or recording. Use this if you want to temporarily stop transcription without ending the meeting.

## Next Steps

- [AI Providers Guide](ai-providers.md) -- Choose the best STT provider for your audio setup
- [Interview Copilot Guide](interview-copilot.md) -- Optimize audio for interviews
- [Lecture Assistant Guide](lecture-assistant.md) -- Audio setup for lecture recording
- [Troubleshooting](troubleshooting.md) -- More solutions for audio and other issues
