use std::env;

use zed_extension_api::settings::LspSettings;
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
    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        let server_exists = Self::server_exists();
        if self.did_find_server && server_exists {
            return Ok(SERVER_PATH.to_string());
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let latest_version = zed::npm_package_latest_version(SERVER_PACKAGE)?;

        if !server_exists
            || zed::npm_package_installed_version(SERVER_PACKAGE)?.as_ref() != Some(&latest_version)
        {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(SERVER_PACKAGE, &latest_version)?;
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

        let env = worktree
            .shell_env()
            .into_iter()
            .filter(|(key, _)| FORWARDED_ENV.contains(&key.as_str()))
            .collect();

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
