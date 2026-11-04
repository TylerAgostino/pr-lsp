/**
 * Token resolution (precedence documented in README):
 * GITHUB_TOKEN wins over GH_TOKEN; the adapter injects `gh auth token`
 * output as GH_TOKEN when neither is otherwise present.
 */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const github = env.GITHUB_TOKEN?.trim();
  if (github) return github;
  const gh = env.GH_TOKEN?.trim();
  if (gh) return gh;
  return null;
}
