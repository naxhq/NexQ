//! Live brief: pure core of the brief engine (local topic-change detector,
//! trigger, sheet parser and validator, holder with staleness and scope rules,
//! prompts, engine). Search, model call, clock, events and saving are injected.

#![allow(dead_code)]

pub mod engine;
pub mod prompts;
pub mod search;
pub mod sheet;
pub mod topic;
pub mod trigger;

pub use engine::{BriefConfig, BriefEngine, BriefLine, BriefSink, BriefSnapshot, BriefStatus, BriefStore, NullBriefSink, NullBriefStore};
pub use prompts::{BRIEF_PROMPT_VERSION, BRIEF_SCHEMA_VERSION};
pub use search::{LocalSearch, Passage};
pub use sheet::{parse_sheet, Fact, Sheet, SheetHolder, SheetView, SentPassage};
pub use topic::{TopicConfig, TopicDetector};
pub use trigger::{BriefAction, BriefTrigger, BriefTriggerConfig, CallReason, ModelDecision};
