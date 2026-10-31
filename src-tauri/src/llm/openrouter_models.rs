use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Enriched model info returned to the frontend.
/// Mirrors the TypeScript `OpenRouterModel` interface in types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub provider_name: String,
    pub description: String,
    pub created: u64,
    pub context_length: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub pricing: OpenRouterPricing,
    pub is_free: bool,
    pub modality: String,
    pub input_modalities: Vec<String>,
    pub output_modalities: Vec<String>,
    pub tokenizer: String,
    pub supports_tools: bool,
    pub supports_reasoning: bool,
    pub supports_web_search: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenRouterPricing {
    pub prompt: f64,
    pub completion: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// In-memory cache with TTL.
pub struct OpenRouterModelCache {
    pub models: Vec<OpenRouterModel>,
    pub fetched_at: Instant,
    pub ttl: Duration,
}

impl OpenRouterModelCache {
    pub fn new(models: Vec<OpenRouterModel>) -> Self {
        Self {
            models,
            fetched_at: Instant::now(),
            ttl: Duration::from_secs(4 * 60 * 60), // 4 hours
        }
    }

    pub fn is_valid(&self) -> bool {
        self.fetched_at.elapsed() < self.ttl
    }
}

/// Parse a price string from the API (e.g., "0.000003") into f64 per 1M tokens.
/// The API returns cost per single token, so multiply by 1_000_000.
fn parse_price(value: &serde_json::Value) -> f64 {
    value
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|p| p * 1_000_000.0)
        .unwrap_or(0.0)
}

/// Parse optional price — returns None if the field is missing.
fn parse_price_opt(obj: &serde_json::Value, key: &str) -> Option<f64> {
    obj.get(key).map(|v| parse_price(v)).filter(|&p| p > 0.0)
}

/// Extract provider display name from model ID prefix.
/// "anthropic/claude-sonnet-4" → "Anthropic"
fn extract_provider_name(id: &str) -> String {
    let prefix = id.split('/').next().unwrap_or(id);
    let mut chars = prefix.chars();
    match chars.next() {
        None => prefix.to_string(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

/// Parse the full API response into Vec<OpenRouterModel>.
/// Filters to models that support text input AND text output.
pub fn parse_models_response(body: &serde_json::Value) -> Vec<OpenRouterModel> {
    let arr = match body.get("data").and_then(|d| d.as_array()) {
        Some(arr) => arr,
        None => return Vec::new(),
    };

    arr.iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let name = m
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&id)
                .to_string();

            // Architecture
            let arch = m.get("architecture")?;
            let modality = arch
                .get("modality")
                .and_then(|v| v.as_str())
                .unwrap_or("text->text")
                .to_string();
            let input_modalities: Vec<String> = arch
                .get("input_modalities")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_else(|| vec!["text".to_string()]);
            let output_modalities: Vec<String> = arch
                .get("output_modalities")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_else(|| vec!["text".to_string()]);

            // Pre-filter: must support text input AND text output
            if !input_modalities.contains(&"text".to_string())
                || !output_modalities.contains(&"text".to_string())
            {
                return None;
            }

            let tokenizer = arch
                .get("tokenizer")
                .and_then(|v| v.as_str())
                .unwrap_or("Other")
                .to_string();

            // Pricing — use fallbacks to avoid dropping models with missing fields
            let pricing_obj = m.get("pricing")?;
            let prompt_price = pricing_obj.get("prompt").map(parse_price).unwrap_or(0.0);
            let completion_price = pricing_obj.get("completion").map(parse_price).unwrap_or(0.0);
            let is_free = prompt_price == 0.0 && completion_price == 0.0;

            // Supported parameters → capabilities
            let supported_params: Vec<String> = m
                .get("supported_parameters")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            let supports_tools = supported_params.contains(&"tools".to_string());
            let supports_reasoning = supported_params.contains(&"reasoning".to_string());
            let supports_web_search =
                supported_params.contains(&"web_search_options".to_string());

            // Top provider info
            let top_provider = m.get("top_provider");
            let max_completion_tokens = top_provider
                .and_then(|tp| tp.get("max_completion_tokens"))
                .and_then(|v| v.as_u64());

            Some(OpenRouterModel {
                provider_name: extract_provider_name(&id),
                id,
                name,
                description: m
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                created: m.get("created").and_then(|v| v.as_u64()).unwrap_or(0),
                context_length: m.get("context_length").and_then(|v| v.as_u64()),
                max_completion_tokens,
                pricing: OpenRouterPricing {
                    prompt: prompt_price,
                    completion: completion_price,
                    image: parse_price_opt(pricing_obj, "image"),
                    cache_read: parse_price_opt(pricing_obj, "input_cache_read"),
                    cache_write: parse_price_opt(pricing_obj, "input_cache_write"),
                },
                is_free,
                modality,
                input_modalities,
                output_modalities,
                tokenizer,
                supports_tools,
                supports_reasoning,
                supports_web_search,
            })
        })
        .collect()
}

/// Fetch models from the OpenRouter API.
pub async fn fetch_openrouter_models(
    api_key: &str,
) -> Result<Vec<OpenRouterModel>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://openrouter.ai/api/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("HTTP-Referer", "https://nexq.app")
        .header("X-Title", "NexQ")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = crate::logging::redact(&response.text().await.unwrap_or_default());
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("Authentication failed ({}): {}", status, body));
        }
        return Err(format!("Failed to fetch models ({}): {}", status, body));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(parse_models_response(&body))
}
