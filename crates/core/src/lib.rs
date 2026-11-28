//! SPEC-011: read-only domain state. No network, child process, environment or filesystem access.
#![forbid(unsafe_code)]

pub const SERVER_NAME: &str = "notion-terminal-files";
pub const GET_CWD: &str = "workspace_get_cwd";

pub struct Workspace {
    public_root: String,
    enabled: bool,
}

impl Workspace {
    /// The caller validated this path. Preserve its spelling as the TS reference does.
    /// With no mutation handler the initial cwd is always the configured root.
    pub fn new(root: &str, disabled: &str, secrets: &[&str]) -> Self {
        let enabled = !disabled
            .split(|c: char| c == ';' || c == ',' || c.is_whitespace())
            .any(|name| name.eq_ignore_ascii_case(GET_CWD));
        let mut literals: Vec<_> = secrets
            .iter()
            .copied()
            .filter(|s| s.encode_utf16().count() >= 8)
            .collect();
        literals.sort_unstable_by(|l, r| r.len().cmp(&l.len()).then_with(|| l.cmp(r)));
        literals.dedup();
        let mut public_root = root.to_owned();
        for literal in literals {
            public_root = public_root.replace(literal, "[REDACTED]");
        }
        Self {
            public_root,
            enabled,
        }
    }
    pub fn listed(&self) -> bool {
        self.enabled
    }
    pub fn get_cwd(&self, name: &str) -> Option<&str> {
        (self.enabled && name == GET_CWD).then_some(self.public_root.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_names_use_the_existing_delimiters_not_substrings() {
        assert!(!Workspace::new("fixture", "other;\n WORKSPACE_GET_CWD,another", &[]).listed());
        let w = Workspace::new("fixture", "workspace_get_cwd_extra", &[]);
        assert_eq!(w.get_cwd(GET_CWD), Some("fixture"));
        assert_eq!(w.get_cwd("absent"), None);
        assert_eq!(
            Workspace::new("fixture", GET_CWD, &[]).get_cwd(GET_CWD),
            None
        );
    }
    #[test]
    fn root_output_preserves_ordinary_text_but_not_whole_credential_values() {
        let w = Workspace::new(
            "C:/тест/fixture-secret-long/token/abc",
            "",
            &["fixture-secret", "fixture-secret-long", "abc"],
        );
        assert_eq!(w.get_cwd(GET_CWD), Some("C:/тест/[REDACTED]/token/abc"));
    }
}
