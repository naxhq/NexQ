//! Deterministic evals for live notes, the live brief and workspace memory:
//! scripted conversations, fixtures of model outputs, a scorer and a one-hour
//! simulation. Test-time tooling; nothing here runs in the app.

#![allow(dead_code)]

pub mod score;
#[cfg(test)]
mod redteam;
pub mod scripted;
pub mod sim;

#[cfg(test)]
mod tests;
