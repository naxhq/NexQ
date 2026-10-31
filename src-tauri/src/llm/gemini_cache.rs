use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

pub struct GeminiCacheClient {
    client: Client,
    api_key: String,
    base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedContent {
    /// Full resource name, e.g. "cachedContents/abc123xyz"
    pub name: String,
    pub model: String,
    pub expire_time: String,
    pub total_token_count: u64,
}

#[derive(Debug, Deserialize)]
struct CreateResponse {
    name: String,
    model: String,
    #[serde(rename = "expireTime", default)]
    expire_time: String,
    #[serde(rename = "usageMetadata", default)]
    usage_metadata: UsageMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct UsageMetadata {
    #[serde(rename = "totalTokenCount", default)]
    total_token_count: u64,
}

impl GeminiCacheClient {
    pub fn new(api_key: &str, base_url: Option<&str>) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or("https://generativelanguage.googleapis.com")
                .trim_end_matches('/')
                .to_string(),
        }
    }

    /// Create a cached content entry on Gemini servers.
    ///
    /// `model` — full model ID with "models/" prefix (e.g. "models/gemini-2.0-flash-001").
    /// `system_instruction` — optional system prompt to bake into the cache.
    /// `context_text` — the large document/reference text to cache.
    /// `ttl_secs` — cache lifetime in seconds (min 60, max 172800).
    pub async fn create(
        &self,
        model: &str,
        system_instruction: Option<&str>,
        context_text: &str,
        ttl_secs: u64,
    ) -> Result<CachedContent, String> {
        let url = format!(
            "{}/v1beta/cachedContents?key={}",
            self.base_url, self.api_key
        );

        // Ensure model has the "models/" prefix
        let model_id = if model.starts_with("models/") {
            model.to_string()
        } else {
            format!("models/{}", model)
        };

        let ttl_clamped = ttl_secs.clamp(60, 172_800);

        let mut body = json!({
            "model": model_id,
            "displayName": "NexQ Meeting Context",
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": context_text}]
                }
            ],
            "ttl": format!("{}s", ttl_clamped)
        });

        if let Some(sys) = system_instruction {
            if !sys.is_empty() {
                body["systemInstruction"] = json!({
                    "parts": [{"text": sys}]
                });
            }
        }

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| format!("Gemini cache create request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = crate::logging::redact(&response.text().await.unwrap_or_default());
            return Err(format!(
                "Gemini cache create failed ({}): {}",
                status, body_text
            ));
        }

        let resp: CreateResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse cache create response: {}", e))?;

        Ok(CachedContent {
            name: resp.name,
            model: resp.model,
            expire_time: resp.expire_time,
            total_token_count: resp.usage_metadata.total_token_count,
        })
    }

    /// Delete a cached content entry by its full resource name.
    pub async fn delete(&self, name: &str) -> Result<(), String> {
        let url = format!(
            "{}/v1beta/{}?key={}",
            self.base_url, name, self.api_key
        );

        let response = self
            .client
            .delete(&url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("Gemini cache delete request failed: {}", e))?;

        if !response.status().is_success() && response.status().as_u16() != 404 {
            let status = response.status();
            let body_text = crate::logging::redact(&response.text().await.unwrap_or_default());
            return Err(format!(
                "Gemini cache delete failed ({}): {}",
                status, body_text
            ));
        }

        Ok(())
    }
}
