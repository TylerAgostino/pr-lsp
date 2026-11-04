// Effective server configuration, merged from LSP settings delivered by the
// adapter under initializationOptions (`{ settings: { ... } }`) or
// workspace/didChangeConfiguration.

export interface EffectiveConfig {
  /**
   * GitHub base URL override. Empty string means github.com.
   * Resolution (documented; tests depend on it): if the value ends with
   * `/api/v3` it is used directly as the REST API root (GitHub Enterprise);
   * otherwise it is treated as a server root and `/api/v3` is appended —
   * so tests can point it at `http://127.0.0.1:{port}`.
   */
  githubBaseUrl: string;
  /** Render end-of-line inlay hint badges on commented lines. */
  inlayHints: boolean;
  /** Directory (workspace-relative) holding draft files. */
  draftsDir: string;
}

export const DEFAULT_CONFIG: EffectiveConfig = {
  githubBaseUrl: "",
  inlayHints: true,
  draftsDir: ".git/pr-review",
};

interface RawSettings {
  githubBaseUrl?: unknown;
  inlayHints?: unknown;
  draftsDir?: unknown;
}

export function configFromSettings(raw: unknown): EffectiveConfig {
  const s: RawSettings = (raw ?? {}) as RawSettings;
  const cfg: EffectiveConfig = { ...DEFAULT_CONFIG };
  if (typeof s.githubBaseUrl === "string") cfg.githubBaseUrl = s.githubBaseUrl.replace(/\/+$/, "");
  if (typeof s.inlayHints === "boolean") cfg.inlayHints = s.inlayHints;
  if (typeof s.draftsDir === "string" && s.draftsDir.length > 0) cfg.draftsDir = s.draftsDir;
  return cfg;
}

/** REST API root for the given config. */
export function apiRoot(cfg: EffectiveConfig): string {
  if (!cfg.githubBaseUrl) return "https://api.github.com";
  if (cfg.githubBaseUrl.endsWith("/api/v3")) return cfg.githubBaseUrl;
  return `${cfg.githubBaseUrl}/api/v3`;
}

/** Server root used for HTML links (permalinks); defaults to github.com. */
export function serverRoot(cfg: EffectiveConfig): string {
  if (!cfg.githubBaseUrl) return "https://github.com";
  if (cfg.githubBaseUrl.endsWith("/api/v3")) {
    return cfg.githubBaseUrl.slice(0, -"/api/v3".length);
  }
  return cfg.githubBaseUrl;
}
