//! Honest failures: what went wrong, in words the user can act on, and a
//! stable kind for the UI. There is no fallback provider: the message names
//! the one that failed.

use crate::ai_runs::AiRunError;

/// `(message, error_kind)`.
pub fn describe(e: &AiRunError, provider: &str, model: &str) -> (String, &'static str) {
    let who = if model.trim().is_empty() { provider.to_string() } else { format!("{provider} ({model})") };
    let msg = match e {
        AiRunError::NoKey { message, .. } => format!("{who} refused the request: {message}"),
        AiRunError::RateLimited { message, plan_limit } => match plan_limit {
            Some(_) => format!("{who} says its usage limit is reached: {message}. Try again later or choose another model for this chat."),
            None => format!("{who} is rate limited: {message}"),
        },
        AiRunError::Unavailable { message } => format!("{who} is not available: {message}"),
        AiRunError::Cancelled => "Stopped.".to_string(),
        AiRunError::TooLong { needed, window } => {
            if *window == 0 {
                format!("This question with its context (about {needed} tokens) is too long for {who}. Choose Lean depth or a model with a larger window.")
            } else {
                format!("This question with its context (about {needed} tokens) does not fit {who}'s window of {window} tokens. Choose Lean depth or a model with a larger window.")
            }
        }
        AiRunError::Preempted => "A live answer in your meeting took priority. Ask again in a moment.".to_string(),
        AiRunError::Other { message } => format!("{who} could not answer: {message}"),
    };
    (msg, e.kind())
}
