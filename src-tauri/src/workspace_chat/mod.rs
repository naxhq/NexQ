//! Workspace chat: ask questions across a workspace's meetings and material.
//! The index and the context ladder live in `workspace_search`; this module
//! is the engine around them (chats, sessions, events) and the wiring.

#![allow(dead_code)]

pub mod approval;
pub mod engine;
pub mod errors;
pub mod guard;
pub mod files;
pub mod hub;
pub mod migrate;
pub mod ops;
pub mod provider;
pub mod runtime;
pub mod scope_adapter;
pub mod store;
pub mod types;

#[cfg(test)]
mod tests;

pub use hub::{ChatCapabilities, ChatHub, ReadOnlyPolicy, ToolContext, ToolPolicy};
