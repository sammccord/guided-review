# Audit lenses

Not every lens applies to every change. Skip a lens that has nothing to bite on, and list it under `scope.unchecked` only if it applied and you could not run it.

## Correctness

- Does the code do what the intent says, on every path, including error and empty paths?
- Trace a suspected bug through the call chain. "This could be nil" is not a finding until you show the caller that passes nil.
- Changed conditionals: check that both branches still hold and that no case was lost from a switch or map.
- Off-by-one, unit, timezone, and encoding mismatches at boundaries.

## Behavior preserved

For refactors, renames, and "no behavior change" claims:

- Compare old and new side by side for each moved function. Look for dropped arguments, reordered side effects, swallowed errors, and changed defaults.
- Deleted code: find what still depended on it (`git grep` in the worktree at `head`).
- Deleted or weakened tests: what behavior lost its coverage?

## Contracts and blast radius

- Public API, wire format, schema, or config changes: who consumes them, and do old clients, old data, and rolling deploys still work?
- Migrations: reversibility, locking on large tables, and backfill ordering against code deploy.
- Permissions and feature flags: is the default safe, and does the flag-off path still work?
- New dependencies or version bumps: why, and what else they pull in.

## Security

- Untrusted input reaching queries, shell, file paths, deserialization, or templates.
- Authorization: is every new entry point checked, and checked against the right principal?
- Secrets or PII in logs, errors, or responses.

## Concurrency and failure

- Shared state touched by more than one request, goroutine, or worker.
- Retries and idempotency: can a retried call double-apply?
- Timeouts, cancellation, and partial failure across network or transaction boundaries.

## Verification

- Do the tests exercise the changed behavior, or only the happy path?
- Would the tests fail if the change were reverted? Check one when it is cheap.
- Run the touched package's tests and type checker. Record the result in `scope.checked`.

## Judging findings

- **Nitpick gravity.** Reviewers pad a thin review with nits. If everything you found is style, the change is probably fine. Say so.
- **Hypothetical versus actual.** A finding about an input needs a reachable caller that produces it.
- **Different, not wrong.** "I would have done it differently" is not a finding unless you can name the concrete problem the current approach causes.
- **Evidence level.** Say whether you ran it, traced it, or inferred it. A safety fact you could not run belongs in a `risk` stop or in `scope.unchecked`, not stated as settled.
