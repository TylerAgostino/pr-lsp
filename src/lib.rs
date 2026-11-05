use std::env;

use zed_extension_api::settings::LspSettings;
use zed_extension_api::process::Command as ZedProcessCommand;
use zed_extension_api::{self as zed, serde_json, Result};

const SERVER_PACKAGE: &str = "pr-review-lsp";
const SERVER_PATH: &str = "node_modules/pr-review-lsp/dist/server.js";

/// Environment variables forwarded from the worktree's shell environment to
/// the language server process (auth + API endpoint overrides).
const FORWARDED_ENV: &[&str] = &[
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_API_URL",
    "GITHUB_ENTERPRISE_URL",
];

struct PrReview {
    did_find_server: bool,
}

impl PrReview {
    fn server_exists() -> bool {
        std::fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    /// Ensures the npm-hosted LSP server package is installed and up to date,
    /// returning the path of the server script relative to the extension
    /// working directory.
    ///
    /// A locally installed server (e.g. `npm install` of a packed tarball for
    /// dev testing an unpublished package) launches even when the registry
    /// lookup fails; only a *missing* server makes the lookup fatal.
    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        let server_exists = Self::server_exists();
        if self.did_find_server && server_exists {
            return Ok(SERVER_PATH.to_string());
        }

        let installed = zed::npm_package_installed_version(SERVER_PACKAGE)?;

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let latest = match zed::npm_package_latest_version(SERVER_PACKAGE) {
            Ok(latest) => Some(latest),
            Err(_) if server_exists && installed.is_some() => {
                // Unpublished/dev package: keep running the local install.
                None
            }
            Err(e) => {
                return Err(format!(
                    "failed to look up '{SERVER_PACKAGE}' on npm: {e}\n\
                     For local development without publishing, install a packed build into the \
                     extension work directory (see README: Development)."
                ));
            }
        };

        if !server_exists || (latest.is_some() && installed != latest) {
            let version = latest.ok_or_else(|| format!("'{SERVER_PACKAGE}' is not installed"))?;
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(SERVER_PACKAGE, &version)?;
            if !Self::server_exists() {
                Err(format!(
                    "installed package '{SERVER_PACKAGE}' did not contain expected path \
                     '{SERVER_PATH}'"
                ))?;
            }
        }

        self.did_find_server = true;
        Ok(SERVER_PATH.to_string())
    }

    /// Fallback token source: `gh auth token`, used only when the shell
    /// environment carries neither `GITHUB_TOKEN` nor `GH_TOKEN`.
    fn gh_auth_token() -> Option<String> {
        let output = ZedProcessCommand::new("gh")
            .args(["auth", "token"])
            .output()
            .ok()?;
        if output.status.unwrap_or(-1) != 0 {
            return None;
        }
        let token = String::from_utf8(output.stdout).ok()?;
        let token = token.trim().to_string();
        if token.is_empty() {
            None
        } else {
            Some(token)
        }
    }
}

impl zed::Extension for PrReview {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_script_path(language_server_id)?;

        let mut env: Vec<(String, String)> = worktree
            .shell_env()
            .into_iter()
            .filter(|(key, _)| FORWARDED_ENV.contains(&key.as_str()))
            .collect();
        let has_token = env.iter().any(|(key, value)| {
            matches!(key.as_str(), "GITHUB_TOKEN" | "GH_TOKEN") && !value.trim().is_empty()
        });
        if !has_token {
            if let Some(token) = Self::gh_auth_token() {
                env.push(("GH_TOKEN".to_string(), token));
            }
        }

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                env::current_dir()
                    .unwrap()
                    .join(server_path)
                    .to_string_lossy()
                    .to_string(),
                "--stdio".to_string(),
            ],
            env,
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|lsp_settings| lsp_settings.settings)
            .unwrap_or_else(|| serde_json::json!({}));
        // The server reads its config from `initialize` params under
        // `initializationOptions.settings` (see server/src/config.ts).
        Ok(Some(serde_json::json!({ "settings": settings })))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|lsp_settings| lsp_settings.settings)
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(Some(settings))
    }
}

zed::register_extension!(PrReview);
