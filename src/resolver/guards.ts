/**
 * A packaging repository builds and publishes someone else's application:
 * `linuxserver/docker-code-server` packages coder/code-server, `docker-library/postgres`
 * packages PostgreSQL. Its releases are container builds, and its prerelease flags mark
 * packaging branches (`develop-*`), not the application's betas -- so neither says anything
 * about the application's own release stream.
 *
 * Narrow on purpose. `pi-hole/docker-pi-hole` and `crazy-max/docker-fail2ban` look like
 * packaging repos by name and are not: the image versions are theirs.
 */
export function isPackagingRepo(repo: string | null | undefined): boolean {
  if (!repo) return false
  return /^linuxserver\/docker-/i.test(repo) || /^docker-library\//i.test(repo) || /-library-image$/i.test(repo)
}
