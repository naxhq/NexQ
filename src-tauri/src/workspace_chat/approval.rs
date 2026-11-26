//! The chat's tool policy: MCP tools that only read run as before; any other
//! tool asks first (Allow once / Deny) through the approval broker. A CLI
//! that cannot ask has those tools switched off, and the composer says which
//! and why. This is the one place that connects chat sessions to
//! `llm::cli_agent::approval`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use super::hub::{ChatCapabilities, ToolContext, ToolOff, ToolPolicy};
use crate::llm::cli_agent::approval::{ApprovalBroker, ApprovalPolicy, ApprovalSupport, ChatApprovals};
use crate::llm::cli_agent::command::SourcesLaunch;
use crate::llm::cli_agent::manager::AgentSessionManager;
use crate::llm::cli_agent::CliAgentKind;
use crate::sources::config::{McpServer, PersonalSourcesConfig};

/// Where a chat's approvals are registered (the session manager in the app).
pub trait ApprovalRegistry: Send + Sync {
    fn register(&self, approvals: ChatApprovals);
    fn clear(&self, chat_id: &str);
}

impl ApprovalRegistry for AgentSessionManager {
    fn register(&self, approvals: ChatApprovals) {
        self.set_chat_approvals(approvals);
    }
    fn clear(&self, chat_id: &str) {
        self.clear_chat_approvals(chat_id);
    }
}

pub struct ApprovalToolPolicy {
    registry: Arc<dyn ApprovalRegistry>,
    broker: Arc<dyn ApprovalBroker>,
    sources: Arc<RwLock<PersonalSourcesConfig>>,
    /// Whether the installed CLI of a kind can ask (`approval_support`).
    support: Arc<dyn Fn(CliAgentKind) -> ApprovalSupport + Send + Sync>,
    prepared: Mutex<HashMap<String, (Arc<ApprovalPolicy>, ApprovalSupport)>>,
}

impl ApprovalToolPolicy {
    pub fn new(
        registry: Arc<dyn ApprovalRegistry>,
        broker: Arc<dyn ApprovalBroker>,
        sources: Arc<RwLock<PersonalSourcesConfig>>,
        support: Arc<dyn Fn(CliAgentKind) -> ApprovalSupport + Send + Sync>,
    ) -> Self {
        Self { registry, broker, sources, support, prepared: Mutex::new(HashMap::new()) }
    }

    fn servers_of(&self, ids: &[String]) -> Vec<McpServer> {
        let cfg = self.sources.read().map(|c| c.clone()).unwrap_or_default();
        cfg.mcp_servers.into_iter().filter(|s| ids.contains(&s.id)).collect()
    }

    fn policy_for(&self, ctx: &ToolContext, scope_dirs: &[std::path::PathBuf]) -> ApprovalPolicy {
        ApprovalPolicy::from_servers(&self.servers_of(ctx.server_ids), scope_dirs.to_vec())
    }

    fn capabilities_of(policy: &ApprovalPolicy, support: &ApprovalSupport) -> ChatCapabilities {
        match support {
            ApprovalSupport::Supported => ChatCapabilities {
                can_ask: true,
                tools_off: vec![],
                notes: if policy.ask_tools().is_empty() {
                    vec![]
                } else {
                    vec!["Tools that can change things ask you first (Allow once or Deny).".into()]
                },
            },
            ApprovalSupport::Unsupported(reason) => {
                let off: Vec<ToolOff> = policy.ask_tools().into_iter().map(|tool| ToolOff { tool, reason: reason.clone() }).collect();
                let mut notes = Vec::new();
                if !off.is_empty() {
                    notes.push(format!("{} tool(s) that could change things are off in this chat. {reason}", off.len()));
                }
                ChatCapabilities { can_ask: false, tools_off: off, notes }
            }
        }
    }
}

impl ToolPolicy for ApprovalToolPolicy {
    fn adjust_launch(&self, ctx: &ToolContext, launch: &mut SourcesLaunch) {
        let Some(kind) = ctx.kind else { return };
        let policy = Arc::new(self.policy_for(ctx, &launch.add_dirs));
        let support = (self.support)(kind);
        policy.adjust_launch(launch, &support);
        self.prepared.lock().unwrap().insert(ctx.chat_id.to_string(), (policy, support));
    }

    fn before_run(&self, ctx: &ToolContext) {
        let prepared = self.prepared.lock().unwrap().get(ctx.chat_id).cloned();
        if let Some((policy, support)) = prepared {
            self.registry.register(ChatApprovals {
                can_ask: support == ApprovalSupport::Supported,
                chat_id: ctx.chat_id.to_string(),
                broker: self.broker.clone(),
                policy,
            });
        }
    }

    fn on_cancel(&self, chat_id: &str) {
        // every open and queued question of the chat is refused
        self.broker.deny_chat(chat_id);
    }

    fn on_close(&self, chat_id: &str) {
        self.registry.clear(chat_id);
        self.prepared.lock().unwrap().remove(chat_id);
    }

    fn describe(&self, ctx: &ToolContext, scope_dirs: &[std::path::PathBuf]) -> ChatCapabilities {
        let Some(kind) = ctx.kind else { return ChatCapabilities::default() };
        let policy = self.policy_for(ctx, scope_dirs);
        Self::capabilities_of(&policy, &(self.support)(kind))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::cli_agent::approval::ApprovalRequest;
    use crate::sources::config::McpTool;

    #[derive(Default)]
    struct Registry {
        registered: Mutex<Vec<ChatApprovals>>,
        cleared: Mutex<Vec<String>>,
    }
    impl ApprovalRegistry for Registry {
        fn register(&self, a: ChatApprovals) {
            self.registered.lock().unwrap().push(a);
        }
        fn clear(&self, chat_id: &str) {
            self.cleared.lock().unwrap().push(chat_id.to_string());
        }
    }

    #[derive(Default)]
    struct Broker {
        denied: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl ApprovalBroker for Broker {
        async fn ask(&self, _req: ApprovalRequest) -> bool {
            false
        }
        fn deny_chat(&self, chat_id: &str) {
            self.denied.lock().unwrap().push(chat_id.to_string());
        }
        fn deny_request(&self, _: &str, _: &str) {}
        fn pending(&self, _: &str) -> usize {
            0
        }
    }

    fn tool(name: &str, key: &str, read_only: Option<bool>) -> McpTool {
        McpTool { name: name.into(), full_name: format!("mcp__{key}__{name}"), allowed: true, read_only_hint: read_only, destructive_hint: None }
    }

    fn setup(support: ApprovalSupport) -> (ApprovalToolPolicy, Arc<Registry>, Arc<Broker>) {
        let registry = Arc::new(Registry::default());
        let broker = Arc::new(Broker::default());
        let cfg = PersonalSourcesConfig {
            mcp_servers: vec![
                McpServer { id: "s1".into(), key: "kb".into(), label: "KB".into(), enabled: true, tools: vec![tool("search", "kb", Some(true)), tool("create_page", "kb", Some(false))], ..Default::default() },
                McpServer { id: "s2".into(), key: "other".into(), label: "Other".into(), enabled: true, tools: vec![tool("delete_all", "other", None)], ..Default::default() },
            ],
            ..Default::default()
        };
        let sup = support.clone();
        let policy = ApprovalToolPolicy::new(registry.clone(), broker.clone(), Arc::new(RwLock::new(cfg)), Arc::new(move |_| sup.clone()));
        (policy, registry, broker)
    }

    fn launch() -> SourcesLaunch {
        SourcesLaunch {
            allowed_tools: vec!["mcp__kb__search".into(), "mcp__kb__create_page".into(), "mcp__other__delete_all".into(), "Read".into()],
            ..Default::default()
        }
    }

    #[test]
    fn a_cli_that_can_ask_keeps_its_tools_and_registers_approvals() {
        let (p, registry, _) = setup(ApprovalSupport::Supported);
        let ids = vec!["s1".to_string()];
        let ctx = ToolContext { chat_id: "c1", kind: Some(CliAgentKind::Claude), server_ids: &ids };
        let mut l = launch();
        p.adjust_launch(&ctx, &mut l);
        assert!(l.disallowed_tools.is_empty());
        p.before_run(&ctx);
        let reg = registry.registered.lock().unwrap();
        assert_eq!(reg.len(), 1);
        assert!(reg[0].can_ask);
        assert_eq!(reg[0].chat_id, "c1");
        // only the chat's own servers are in its policy
        assert_eq!(reg[0].policy.mcp("kb", "search"), crate::llm::cli_agent::approval::ToolVerdict::Allow);
        assert_ne!(reg[0].policy.mcp("kb", "create_page"), crate::llm::cli_agent::approval::ToolVerdict::Allow);
        assert!(!reg[0].policy.tools.contains_key(&("other".to_string(), "delete_all".to_string())));
        let caps = p.describe(&ctx, &[]);
        assert!(caps.can_ask && caps.tools_off.is_empty());
        assert!(caps.notes[0].contains("ask you first"));
    }

    #[test]
    fn a_cli_that_cannot_ask_has_those_tools_off_and_says_why() {
        let (p, registry, _) = setup(ApprovalSupport::Unsupported("Codex can't ask yet.".into()));
        let ids = vec!["s1".to_string(), "s2".to_string()];
        let ctx = ToolContext { chat_id: "c1", kind: Some(CliAgentKind::Codex), server_ids: &ids };
        let mut l = launch();
        p.adjust_launch(&ctx, &mut l);
        assert!(l.disallowed_tools.contains(&"mcp__kb__create_page".to_string()));
        assert!(l.disallowed_tools.contains(&"mcp__other__delete_all".to_string()), "unknown tools ask, so they are off");
        assert!(!l.allowed_tools.contains(&"mcp__kb__create_page".to_string()));
        assert!(l.allowed_tools.contains(&"mcp__kb__search".to_string()) && l.allowed_tools.contains(&"Read".to_string()));
        p.before_run(&ctx);
        assert!(!registry.registered.lock().unwrap()[0].can_ask);
        let caps = p.describe(&ctx, &[]);
        assert!(!caps.can_ask);
        assert_eq!(caps.tools_off.len(), 2);
        assert!(caps.tools_off.iter().all(|t| t.reason.contains("Codex can't ask yet.")));
        assert!(caps.notes[0].contains("off in this chat"));
    }

    #[test]
    fn cancel_refuses_open_questions_and_close_forgets_the_chat() {
        let (p, registry, broker) = setup(ApprovalSupport::Supported);
        let ids = vec!["s1".to_string()];
        let ctx = ToolContext { chat_id: "c1", kind: Some(CliAgentKind::Claude), server_ids: &ids };
        let mut l = launch();
        p.adjust_launch(&ctx, &mut l);
        p.on_cancel("c1");
        assert_eq!(broker.denied.lock().unwrap().as_slice(), ["c1"]);
        p.on_close("c1");
        assert_eq!(registry.cleared.lock().unwrap().as_slice(), ["c1"]);
        p.before_run(&ctx); // nothing prepared any more
        assert!(registry.registered.lock().unwrap().is_empty());
    }
}
