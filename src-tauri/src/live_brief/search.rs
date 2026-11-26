//! The local search the brief engine asks for passages. The real one is the
//! workspace index (section 4 of the spec); the engine only sees this trait.

/// A passage found in the scope's index.
#[derive(Debug, Clone, PartialEq)]
pub struct Passage {
    /// Stable id in the index (`doc:12#3`).
    pub id: String,
    pub title: String,
    pub text: String,
    pub start_ms: Option<u64>,
}

pub trait LocalSearch: Send + Sync {
    /// Best passages first. `limit_tokens` is a hint for how much the caller will keep.
    fn search(&self, query: &str, limit_tokens: u32, max: usize) -> Vec<Passage>;
}

impl<F> LocalSearch for F
where
    F: Fn(&str, u32, usize) -> Vec<Passage> + Send + Sync,
{
    fn search(&self, query: &str, limit_tokens: u32, max: usize) -> Vec<Passage> {
        self(query, limit_tokens, max)
    }
}
