---
name: review-loop
description: Get an independent review of your own change from a second agent, fix what it finds, and repeat until it approves. Use before you open or update a fork pull request, or when the owner asks for a review loop. Not for reviews of pull requests by other people.
---

# Review loop

The agent that wrote a change does not review it alone. A second agent reviews it in rounds.

## 1. Prepare

1. Commit the change on its branch. A WIP commit is fine.
2. Record `BASE=$(git merge-base origin/main HEAD)`.
3. Write the intent and the out-of-scope items in one or two sentences.
4. Run the checks that cover the change. Record the results.

## 2. Choose the reviewer

Call `orchestrator_capabilities`. Take the first option that runs:

1. A strong model of a different provider than the one that wrote the change, through `delegate_task`.
2. A fresh subagent of your own model, through `delegate_task`.

Do not hardcode a model id. If no reviewer runs, stop and report it. A self-review is not a review.

## 3. Run a round

Each round is a new `delegate_task` call with `mode: "async"`, `isolation: "worktree"` and a new `clientRequestId` (`review-<branch>-<first 8 characters of the head SHA when the loop starts>-r<N>`). Reuse an id only to retry the same round. Do not edit the change while a round runs. A timeout or an error is not approval.

Brief for round 1:

```
Review only. Do not edit files, commit, push, comment on GitHub, or start subagents.
Repository: <path>. Base: <BASE>. Head: <sha>. Intent: <intent>. Out of scope: <items>.
Checks: <results>. Read `git diff <BASE>...<sha>`, the surrounding code and AGENTS.md.
Find bugs, broken callers, mismatches with the intent, and code that the intent does not need.
Label each finding: blocker (the intended case fails, or a security hole), should (a real bug
that callers hit, or a simpler way to write the same change), nit (the rest).
Start only your last message with FINAL REPORT. Reply:
VERDICT: APPROVE or CHANGES
R1 [blocker|should|nit] <file>:<line> <problem>. Fix: <suggestion>
```

From round 2, also send every earlier finding and its outcome: `fixed: <commit>`, `disagree: <evidence>` or `declined: <reason>`. Ask the reviewer to check only open findings and the code that changed.

## 4. Answer the findings

- Check each finding against the code. Reviewers are wrong sometimes.
- Agree: make the smallest fix. Add one focused test if the fix needs it.
- Disagree: give evidence, such as a `file:line`, a test or command output.
- Decline nits and out-of-scope items in one line.
- Re-run the checks and commit before the next round.

## 5. Stop

- Stop when the verdict is APPROVE, or when only nits are open.
- Use 3 rounds at most. Use up to 5 only while a blocker about security, data loss or concurrency is open.
- If a finding stays disputed after two replies, or the rounds end, show both sides to the owner. The end of the rounds is not approval.

Add the result to the "Review" section of the pull request: the reviewer kind, the number of rounds, the verdict, and what the review changed. Do not name the model: the fork rules forbid model and AI credit lines.
