# GitHub Actions pinning policy

Every action is pinned to a full upstream release commit. The workflow comment beside each SHA records the reviewed human-readable version. The initial pins were resolved directly from the upstream Git tag refs rather than copied from an untrusted workflow.

Enable Dependabot or Renovate for `github-actions`, and review rather than auto-merge SHA updates. A dependency bot update must retain the full 40-character SHA and update the adjacent version comment.

The action audit checklist is:

1. Confirm the repository owner and release tag upstream.
2. Resolve the tag to a full commit SHA through two trusted views.
3. Review release notes, permission changes, Node runtime changes, and transitive behavior.
4. Pin the SHA in every workflow occurrence.
5. Run CI and a staging deployment before merging.

New workflows may not introduce floating branches such as `main`, unversioned container tags, or unpinned global CLIs. Wrangler is resolved from the frozen workspace lockfile; Vercel, Appwrite CLI, and release Wrangler global installs use explicit versions.

Pinning does not replace least privilege. Review each action's `permissions`, environment access, and secret exposure. Appwrite deploy/runtime/backup keys stay separated and environment-specific, while CLI publication uses short-lived npm OIDC rather than a long-lived package token.
