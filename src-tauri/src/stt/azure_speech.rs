// Sub-PRD 9: Azure Cognitive Services Speech-to-Text
//
// Accumulates audio chunks into ~5 second segments, then sends each segment
// as WAV data via REST to the Azure Speech-to-Text endpoint:
//   https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
//
// Uses Ocp-Apim-Subscription-Key header for authentication.
// Supports language selection via the `language` query parameter.

use async_trait::async_trait;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// Target segment duration in seconds before sending a batch to the API.
const SEGMENT_DURATION_SECS: f32 = 5.0;

/// Sample rate expected by the audio pipeline (16 kHz mono).
const SAMPLE_RATE: u32 = 16000;

/// Azure Speech recognition response (simple format).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
#[allow(dead_code)]
struct AzureRecognitionResult {
    recognition_status: Option<String>,
    display_text: Option<String>,
    offset: Option<u64>,
    duration: Option<u64>,
}

/// Azure Cognitive Services Speech-to-Text provider.
///
/// Accumulates PCM audio into ~5-second segments and POSTs them as WAV to
/// the Azure Speech REST API.
pub struct AzureSpeechSTT {
    subscription_key: String,
    region: String,
    language: String,
    is_streaming: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    stop_flag: Arc<AtomicBool>,
    start_time: Option<Instant>,
    /// Accumulated PCM samples for the current segment.
    audio_buffer: Vec<i16>,
    /// Total samples needed before sending (~5 seconds at 16 kHz).
    segment_sample_threshold: usize,
}

impl AzureSpeechSTT {
    pub fn new() -> Self {
        Self {
            subscription_key: String::new(),
            region: "eastus".to_string(),
            language: "en-US".to_string(),
            is_streaming: false,
            result_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            start_time: None,
            audio_buffer: Vec::new(),
            segment_sample_threshold: (SAMPLE_RATE as f32 * SEGMENT_DURATION_SECS) as usize,
        }
    }

    /// Create with subscription key and region.
    pub fn with_config(subscription_key: &str, region: &str) -> Self {
        Self {
            subscription_key: subscription_key.to_string(),
            region: region.to_string(),
            ..Self::new()
        }
    }

    /// Set the subscription key.
    pub fn set_subscription_key(&mut self, key: &str) {
        self.subscription_key = key.to_string();
    }

    /// Set the Azure region (e.g., "eastus", "westeurope").
    pub fn set_region(&mut self, region: &str) {
        self.region = region.to_string();
    }

    /// Get the Azure region.
    pub fn region(&self) -> &str {
        &self.region
    }

    /// Build the Azure REST endpoint URL.
    fn build_endpoint_url(&self) -> String {
        format!(
            "https://{}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language={}&format=simple",
            self.region, self.language
        )
    }

    /// Encode accumulated PCM i16 samples as a WAV byte buffer (16-bit mono 16 kHz).
    fn encode_wav(samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let file_len = 36 + data_len;
        let mut buf = Vec::with_capacity(44 + data_len as usize);

        // RIFF header
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&file_len.to_le_bytes());
        buf.extend_from_slice(b"WAVE");

        // fmt sub-chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        buf.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

        // data sub-chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        for &sample in samples {
            buf.extend_from_slice(&sample.to_le_bytes());
        }

        buf
    }

    /// Send accumulated audio to the Azure Speech API and emit the result.
    async fn send_segment(
        subscription_key: &str,
        endpoint_url: &str,
        samples: Vec<i16>,
        timestamp_ms: u64,
        language: &str,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) {
        let wav_data = Self::encode_wav(&samples);

        let client = reqwest::Client::new();
        let response = client
            .post(endpoint_url)
            .header("Ocp-Apim-Subscription-Key", subscription_key)
            .header("Content-Type", "audio/wav; codecs=audio/pcm; samplerate=16000")
            .header("Accept", "application/json")
            .body(wav_data)
            .send()
            .await;

        match response {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.json::<AzureRecognitionResult>().await {
                        Ok(azure_resp) => {
                            let status = azure_resp
                                .recognition_status
                                .as_deref()
                                .unwrap_or("");

                            if status == "Success" {
                                if let Some(text) = azure_resp.display_text {
                                    let text = text.trim().to_string();
                                    if !text.is_empty() {
                                        let result = TranscriptResult {
                                            text,
                                            is_final: true,
                                            confidence: 0.90,
                                            timestamp_ms,
                                            speaker: None,
                                            language: Some(language.to_string()),
                                            segment_id: None,
                                            duration_ms: None,
                                            speaker_tag: None,
                                            turn: None,
                                        };
                                        let _ = result_tx.send(result).await;
                                    }
                                }
                            } else if status == "NoMatch" {
                                log::debug!("AzureSpeechSTT: No speech recognized in segment");
                            } else {
                                log::warn!(
                                    "AzureSpeechSTT: Recognition status: {}",
                                    status
                                );
                            }
                        }
                        Err(e) => {
                            log::error!("AzureSpeechSTT: Failed to parse response: {}", e);
                        }
                    }
                } else {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    log::error!(
                        "AzureSpeechSTT: API returned status {}: {}",
                        status,
                        body
                    );
                }
            }
            Err(e) => {
                log::error!("AzureSpeechSTT: Request failed: {}", e);
            }
        }
    }
}

#[async_trait]
impl STTProvider for AzureSpeechSTT {
    fn provider_name(&self) -> &str {
        "Azure Speech"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::AzureSpeech
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        if self.subscription_key.is_empty() {
            return Err("Azure subscription key not configured".into());
        }

        if self.region.is_empty() {
            return Err("Azure region not configured".into());
        }

        log::info!(
            "AzureSpeechSTT: Starting stream (region: {}, language: {})",
            self.region,
            self.language
        );

        self.result_tx = Some(result_tx);
        self.is_streaming = true;
        self.stop_flag.store(false, Ordering::SeqCst);
        self.start_time = Some(Instant::now());
        self.audio_buffer.clear();

        log::info!("AzureSpeechSTT: Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming || self.stop_flag.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Skip only absolute digital silence (all-zero samples).
        // System audio via WASAPI loopback can be very quiet, so use a
        // minimal threshold. The STT API handles silence gracefully.
        if !chunk.pcm_data.is_empty() {
            let rms: f64 = chunk
                .pcm_data
                .iter()
                .map(|&s| (s as f64) * (s as f64))
                .sum::<f64>()
                / chunk.pcm_data.len() as f64;
            if rms < 0.25 {
                return Ok(());
            }
        }

        self.audio_buffer.extend_from_slice(&chunk.pcm_data);

        // When we have ~5 seconds of audio, send it as a batch
        if self.audio_buffer.len() >= self.segment_sample_threshold {
            let segment = std::mem::take(&mut self.audio_buffer);
            let timestamp_ms = self
                .start_time
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(chunk.timestamp_ms);

            if let Some(ref tx) = self.result_tx {
                // Send an interim result to indicate processing
                let interim = TranscriptResult {
                    text: "[transcribing...]".to_string(),
                    is_final: false,
                    confidence: 0.0,
                    timestamp_ms,
                    speaker: None,
                    language: Some(self.language.clone()),
                    segment_id: None,
                    duration_ms: None,
                    speaker_tag: None,
                    turn: None,
                };
                let _ = tx.send(interim).await;

                // Spawn the API call
                let subscription_key = self.subscription_key.clone();
                let endpoint_url = self.build_endpoint_url();
                let language = self.language.clone();
                let result_tx = tx.clone();
                tokio::spawn(async move {
                    Self::send_segment(
                        &subscription_key,
                        &endpoint_url,
                        segment,
                        timestamp_ms,
                        &language,
                        result_tx,
                    )
                    .await;
                });
            }
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        log::info!("AzureSpeechSTT: Stopping stream");

        self.stop_flag.store(true, Ordering::SeqCst);

        // Flush remaining audio buffer
        if !self.audio_buffer.is_empty() {
            let segment = std::mem::take(&mut self.audio_buffer);
            let timestamp_ms = self
                .start_time
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);

            if let Some(ref tx) = self.result_tx {
                let subscription_key = self.subscription_key.clone();
                let endpoint_url = self.build_endpoint_url();
                let language = self.language.clone();
                let result_tx = tx.clone();
                let handle = tokio::spawn(async move {
                    Self::send_segment(
                        &subscription_key,
                        &endpoint_url,
                        segment,
                        timestamp_ms,
                        &language,
                        result_tx,
                    )
                    .await;
                });
                // Wait for the final segment to be sent (with timeout)
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    handle,
                ).await;
            }
        }

        self.is_streaming = false;
        self.result_tx = None;
        self.start_time = None;

        log::info!("AzureSpeechSTT: Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if self.subscription_key.is_empty() {
            return Err("No subscription key configured".into());
        }

        if self.region.is_empty() {
            return Err("No region configured".into());
        }

        log::info!(
            "AzureSpeechSTT: Testing connection (region: {})...",
            self.region
        );

        // Test by issuing a token request to the token endpoint.
        // A successful response (200) means the key and region are valid.
        let token_url = format!(
            "https://{}.api.cognitive.microsoft.com/sts/v1.0/issueToken",
            self.region
        );

        let client = reqwest::Client::new();
        let response = client
            .post(&token_url)
            .header("Ocp-Apim-Subscription-Key", &self.subscription_key)
            .header("Content-Length", "0")
            .body("")
            .send()
            .await?;

        let success = response.status().is_success();
        if success {
            log::info!("AzureSpeechSTT: Connection test passed");
        } else {
            log::warn!(
                "AzureSpeechSTT: Connection test failed with status {}",
                response.status()
            );
        }

        Ok(success)
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.to_string();
        log::info!("AzureSpeechSTT: Language set to {}", self.language);
    }
}
