# Helm development and rollout

For requested Helm development, finish the work by validating it, committing and
pushing to main, and updating every reachable installed machine. Check the source
checkout, installed checkout, running daemon version and served web build separately.
Preserve existing local changes; reconcile them or keep the old installed tree as a
backup before installing a clean release. Do not leave finished fixes only as dirty
edits in installed checkouts, because that blocks automatic updates.
Develop in the source checkout or a separate worktree. Keep temporary scripts and
machine-local helpers under ~/.helm, outside installed release checkouts.

The owner's ~/.helm is production state. Tests must use a temporary HELM_DIR,
HELM_DB, HELM_SSH_DIR and process sockets, set before importing any Helm module.
Never create, join, leave, replace or restore the owner's network for a test, and
never restart the production daemon to make a test pass. Keep running owner chats
undisturbed; use isolated test hubs and the safe restart worker for deployments.

Use `helm digest` to check reachability and active sessions. Prefer `helm exec` for
remote commands. Run expensive checks and builds through `helm run --heavy` (or
`helm exec <machine> --heavy`) and use Helm's safe restart worker so hosted sessions
survive and outstanding approvals or active transfers can finish.

Report unreachable machines explicitly. An offline machine has not been deployed
or verified; a clean service-managed install catches up from GitHub or peers when
it reconnects. Keep update failures visible and verify the live release after rollout.
