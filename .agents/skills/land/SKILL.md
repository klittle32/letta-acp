---
name: land
description: >-
  Land requested changes to main in the klittle32/letta-acp GitHub fork.
  Invoke only when the user explicitly requests landing, including /land;
  not for review, preparation, passing checks, or skill installation.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Land changes to the personal fork

An explicit landing request authorizes this workflow. Proceed without asking
again whether to merge. Stop for actual blockers, unclear scope, or unsafe
operations. Installing this skill alone does not authorize landing.

## Scope and preflight

- Work only in the attached repository checkout. Leave the original local
  checkout untouched; never push to the `local` remote.
- The destination is `main` at `github.com/klittle32/letta-acp`. Inspect fetch
  and push URLs with `git remote -v` and verify `origin` addresses that fork.
  Stop if it does not. Never push to letta-ai, open an upstream PR, publish
  packages, create release tags, or dispatch the release workflow.
- Read current applicable repository instructions and inspect
  `git --no-optional-locks status --short`, staged and unstaged diffs, and
  commits ahead of the destination. Determine exactly which changes the user
  requested. Preserve unrelated edits and commits; ask if scope is unclear.
  Do not stash, reset, clean, or stage everything indiscriminately.
- Check Git identity, existing signing configuration, tool availability, and
  GitHub authentication without exposing tokens or secret values. Preserve
  signing settings. Required tools are Git, GitHub CLI, Node, npm, and Bun.
- Read current `package.json` and `.github/workflows/ci.yml`. Node must satisfy
  the manifest's `>=22.19.0` requirement. At creation, CI uses Node 22 and Bun
  1.3.2, while the manifest declares Bun 1.3.0. Report runtime differences;
  do not silently treat another runtime as CI-equivalent or install tooling
  outside the workspace without permission.
- Inspect current GitHub branch protection and applicable rulesets using
  read-only GitHub API queries for `klittle32/letta-acp`. Verify permission
  to push. An inaccessible policy is not evidence that no policy applies.
  Satisfy all applicable checks, signing, and review requirements. If a PR
  is required, stop and explain rather than bypassing policy or opening one
  without agreement.

## Prepare the candidate

1. Fetch `origin main` and inspect divergence. Identify a candidate containing
   the requested changes on top of the fetched destination, excluding unrelated
   work. Create a local topic branch if needed to keep the preparation clear.
2. Review the diff for secrets, unintended files, regressions, and required
   documentation/tests. Follow the review guidance in
   `.skills/working-on-letta-acp/SKILL.md`; technical commands must match current
   manifests and workflows, not stale examples in that document.
3. Stage only explicit agreed paths or hunks and create descriptive commits
   with `GIT_EDITOR=true git commit -m "..."`. Do not amend published commits.
   Integrate destination changes with a non-interactive merge when necessary,
   using `GIT_EDITOR=true git merge --no-edit origin/main`; never force-push or
   rewrite published history.
4. Resolve conflicts automatically only when the intended result is clear and
   unrelated work is preserved. For ambiguous conflicts, report the affected
   files, state that nothing has landed, and pause for the user.

## Verify the exact candidate before landing

All required checks must pass on the final integrated candidate. Pending,
missing, failing, or unverifiable required checks block landing, including
known baseline failures. Never substitute a passing subset for a full check.
Any subsequent code or dependency change invalidates affected earlier results.

- Run `bun install --frozen-lockfile`, then `bun run check`.
  Sources: `.github/workflows/ci.yml`, validate job's install and check steps;
  `package.json` scripts defines check as tests, typecheck, and build.
  Confirm installation has not changed tracked files unexpectedly.
- For ACP boundary changes, including ACP SDK updates, also run
  `bun run test:acpx`.
  Sources: `package.json` scripts and
  `.skills/working-on-letta-acp/SKILL.md`, ACP client compatibility guidance.
- For dependency, packaging, or entrypoint changes, execute the consumer-pack
  verification from `.github/workflows/ci.yml`, validate job's
  "Pack and install as a consumer" step. Use an isolated workspace-local
  temporary directory for its pack and consumer directories, substituting
  that directory for `RUNNER_TEMP`; preserve the step's assertions and ACP
  initialize exchange. Do not use `npm publish`. If the shell/platform
  cannot execute that verification faithfully, report the blocker or use an
  already available suitable environment with permission where necessary.
- For backend/auth changes, use the currently defined
  `bun run test:backend:live:local` and/or
  `bun run test:backend:live:cloud` as appropriate.
  Sources: `package.json` scripts and `.github/workflows/ci.yml` live jobs.
  These replace stale `test:acpx:live` examples, which have no script definition.
  Live tests need dedicated test resources and may create sessions or incur
  provider cost; obtain permission before running them unless already granted.
  Inspect credential presence only, never values. Missing required credentials
  or permission blocks the applicable verification.
- Run `git diff --check` and inspect the final candidate against `origin/main`.
  Verify no unrelated commits or files will be included.
- Satisfy every remote pre-merge check required by current destination rules
  on this candidate, not an earlier SHA. The current CI workflow runs on PRs
  and pushes to main, not arbitrary topic pushes. Do not assume a topic push
  will run CI. If required pre-landing remote checks cannot be obtained under
  this direct-push workflow, stop and explain the needed workflow decision.
  Never weaken branch rules or disable tests to unblock landing.

## Land and verify

1. Fetch `origin main` again immediately before pushing. If it advanced,
   integrate it without rewriting published history and repeat verification
   for the updated candidate. Stop on ambiguous conflicts or failing checks.
2. After all required pre-landing checks pass, push the verified candidate
   normally with `git push origin HEAD:refs/heads/main`. A rejected push is
   not permission to force it; refetch and reassess.
3. Verify the remote destination using `git ls-remote origin refs/heads/main`
   and a fetch. Confirm the landed commit is the destination tip or an ancestor
   if another legitimate push subsequently advanced it.
4. Inspect the GitHub Actions run for the pushed SHA in `klittle32/letta-acp`.
   Report each resulting CI status, including the live-backend jobs. Do not
   treat pending, skipped, missing, or failed required checks as passing.
   Use bounded waits, and report pending checks honestly if the wait expires.
5. Distinguish publication from verification: a confirmed push means the
   commit landed, but failed post-push CI means it is not fully validated.
   Report that condition and the failing job; never automatically revert,
   force-push, alter secrets, or bypass checks.
6. Report the destination branch, landed commit, verification results, and
   remaining blockers. If landing stopped before a successful push, explicitly
   state that changes have not landed. Leave unrelated work and the original
   local checkout untouched.
