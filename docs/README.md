# Helm docs, for agents

Read [intent.md](intent.md) first: what Helm is for, what is settled, and
the two rules that break machines without warning.

## Proving a feature works

[features/](features/README.md) has the steps to drive each feature in a
private Helm, with what counts as proof and the tests to run.

## Where the AI tools differ

[engines.md](engines.md): what each CLI supports (approvals, pictures,
models, rewind, history) and the traps in each driver.

## Decisions and traps

| Doc | About |
|---|---|
| [visual-replies.md](visual-replies.md) | Pages and diagrams in a chat, their look and sandbox |
| [rewind.md](rewind.md) | Edit from here: which chats can rewind, and how |
| [session-settings.md](session-settings.md) | Where a chat's mode, model and effort come from |
| [browser-use.md](browser-use.md) | The browser each chat shares with the owner |
| [integrations.md](integrations.md) | Connectors, skills and plugins per account |
| [share-flow-control.md](share-flow-control.md) | Spin traffic on the machine-to-hub link |
| [recovery-checks.md](recovery-checks.md) | What `helm ship` checks, on private data only |
| [backups.md](backups.md) | Offline encrypted backups and restore |
| [rust-log-reader.md](rust-log-reader.md) | What Rust reads in chat logs, and what stays in JavaScript |
| [linux-package.md](linux-package.md) | The Linux package and what it carries |
| [ready-packages.md](ready-packages.md) | Checked app packages next to Git bundle updates |
| [agenda.md](agenda.md) | What the owner wants next |

## Rules for these docs

- A doc here holds a decision and its reason, a rule that crosses
  components, or a trap the code does not show. Before you add a paragraph,
  ask what an agent would get wrong without it. If the code answers it,
  leave it out.
- Do not list fields, functions or files, tell the control flow, or add a
  summary of your change. The code, tests and `git log` hold that.
- Put an explanation for one place in a code comment there. Link to the
  source; do not copy it.
- When a decision changes, rewrite or delete the old text. Never add a
  second account of the new behaviour.
- A new doc needs its own lasting reason. Add it to this list.
