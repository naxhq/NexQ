//! Live notes: the pure core of the notes engine (document, operation parser,
//! reducer with the protection rules, trigger state machine, prompts, engine,
//! v12 migration and database functions). The model call, clock, events and
//! saving are injected through traits; see `engine`.


pub mod db;
pub mod doc;
pub mod engine;
pub mod migrate;
pub mod ops;
pub mod prompts;
pub mod reducer;
pub mod trigger;

pub use db::{delete_notes, load_notes, save_notes, StoredNotes};
pub use doc::{Block, BlockKind, NoteDoc, Span, SpanKind};
pub use engine::{NotesConfig, NotesEngine, NotesSink, NotesStatus, NotesStore, NullSink, NullStore, TranscriptLine};
pub use migrate::migrate_notes;
pub use ops::{parse_ops, ParseMode, ParsedOps, RawOp};
pub use prompts::{Detail, NotesPromptOptions, OutputLanguage, NOTES_PROMPT_VERSION, NOTES_SCHEMA_VERSION};
pub use reducer::{apply_ops, check_invariants, ReduceCtx, ReduceLimits, ReduceReport};
pub use trigger::{Decision, NotesTrigger, NotesTriggerConfig, RunReason};
