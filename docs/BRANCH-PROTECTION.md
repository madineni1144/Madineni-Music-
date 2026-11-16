# Branch protection for `main` (instructions only - nothing has been changed)

State observed on 2026-11-16 (read-only API calls): `main` has **no branch protection** and the
repository has **no rulesets**. Anyone with write access can merge or push to `main` with failing
or missing checks. Merge commits, squash and rebase merges are all enabled.

## Required status checks - the names GitHub actually reports

These are the check-run names returned by the GitHub API for the workflow run on head `d5f21cf`
(pull_request run 43952256087). A required status check matches on **this exact string**:

| # | Required context (exact) | What it proves |
|---|---|---|
| 1 | `backend tests (security route tests must run, never skip)` | all backend unit and route tests ran; skipped/todo fails the job |
| 2 | `backend integration (disposable PostgreSQL, synthetic data only)` | write routes against a real PostgreSQL 16 service container |
| 3 | `CI gate self-test (a failing command piped through tee must fail its step)` | the gate pattern in 1 and 2 cannot mask a failure |
| 4 | `airflow image imports (separate test tag, no DAGs started)` | the pipeline image builds and imports, DAG loads, nothing started |
| 5 | `pipeline-paths` | Python unit tests and compile check |

`pipeline-paths` has no `name:` in the workflow, so its context is the job id. **Renaming any job
changes its context**: GitHub would then wait forever for the old name (blocking every PR) or, if the
rule is edited without noticing, stop enforcing it. Change names and the rule together.

The workflow triggers on both `pull_request` and `push` (to `main` and `fix/**`), so each of these
appears twice for a `fix/**` branch with an open PR; the names are identical, which is what the rule
matches.

## Setting it up (a repository admin does this; Claude has not)

GitHub UI: Settings -> Branches -> Add branch protection rule (or Rules -> Rulesets) -> branch name
pattern `main`, then:

- [x] Require a pull request before merging
- [x] Require status checks to pass before merging -> add the five contexts above
      (they only appear in the search box if they have run in the last 7 days)
- [x] **Require branches to be up to date before merging** (this is `strict`)
- [x] Do not allow force pushes; do not allow deletions
- Optional, owner's decision: "Require approvals" (note: on a single-owner repository GitHub does not let
  you approve your own pull request, so requiring 1 approval would block you unless a second reviewer
  or a bypass exists); "Do not allow bypassing the above settings" (applies the rules to admins too).

Equivalent API call (review, then run as an admin; the values in `protection.json` are not secrets):

```bash
cat > protection.json <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "backend tests (security route tests must run, never skip)",
      "backend integration (disposable PostgreSQL, synthetic data only)",
      "CI gate self-test (a failing command piped through tee must fail its step)",
      "airflow image imports (separate test tag, no DAGs started)",
      "pipeline-paths"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
gh api -X PUT repos/madineni1144/Madineni-Music-/branches/main/protection --input protection.json
```

Verify afterwards (read-only):
`gh api repos/madineni1144/Madineni-Music-/branches/main/protection/required_status_checks`
must list the five contexts and `"strict": true`.

## Order matters

Turn protection on **before** merging the stack, not after, otherwise the first merge is unprotected.
Because the rule requires "up to date", each later merge needs the branch to contain the new `main`
(see MERGE-SEQUENCE.md). The `strict` rule applies to pull requests targeting `main`; PRs #4 and #6 are
currently stacked on the hardening branch, which is unprotected, until they are retargeted.

## Limits of this protection

It enforces that the five jobs are green on the PR head. It does not review the change, and the
checks do not exercise the live server, nginx/Cloudflare, or the production database schema.
