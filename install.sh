#!/usr/bin/env bash
#
# helm installer.
#
#   curl -fsSL https://raw.githubusercontent.com/HaseebUllahButt/helm/main/install.sh | bash
#
# Installs helm and everything it needs into your home directory, then starts
# it in the background. Safe to re-run: it updates in place and
# never touches a network you have already joined.
#
# Nothing here needs root. helm runs as you, with your agents' credentials,
# because that is the whole point of it.
set -euo pipefail

REPO="${HELM_REPO:-https://github.com/HaseebUllahButt/helm.git}"
BRANCH="${HELM_BRANCH:-main}"
DIR="${HELM_INSTALL_DIR:-$HOME/.helm-src}"
BIN_DIR="$HOME/.local/bin"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\nhelm: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

# --------------------------------------------------------------- preflight

step "checking what is already here"

need git || die "git is required.  sudo apt install git   (or your package manager)"

need node || die "Install Node 22 or newer, then run this installer again. See https://nodejs.org."
need npm || die "Install npm with Node, then run this installer again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]') || die "Cannot run Node."
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "Cannot read the Node version." ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || die "Install Node 22 or newer. See https://nodejs.org."
# A version number alone does not prove SQLite is available (early Node 22
# releases need a flag). Exercise the features without writing a database.
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(":memory:");
  if (db.prepare("SELECT 1 AS ok").get().ok !== 1) process.exit(1);
  db.close();
  if (typeof fetch !== "function" || typeof WebSocket !== "function") process.exit(1);
' >/dev/null 2>&1 || die "This Node cannot run Helm. Install a current Node release with built-in SQLite."
npm --version >/dev/null 2>&1 || die "Cannot run npm. Install npm with Node."
say "node $(node -v)"
NODE_BIN=$(command -v node)
case "$NODE_BIN" in /*) ;; *) NODE_BIN="$PWD/$NODE_BIN" ;; esac
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac

git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || die "Choose a valid Helm branch with HELM_BRANCH."
if ! need herdr && [ ! -x "$BIN_DIR/herdr" ]; then
  need curl || die "Install curl, then run this installer again."
fi

# ------------------------------------------------------------------ fetch

step "checking the install folder"
if [ -e "$DIR" ] || [ -L "$DIR" ]; then
  [ -d "$DIR" ] || die "The install path is not a folder: $DIR"
  # Accept .git files too: linked worktrees use them. Never treat a folder
  # inside another checkout as the install root.
  if [ -e "$DIR/.git" ]; then
    ROOT=$(git -C "$DIR" rev-parse --show-toplevel) || die "Cannot read the checkout in $DIR."
    [ "$(cd "$DIR" && pwd -P)" = "$(cd "$ROOT" && pwd -P)" ] || die "The install folder must be the checkout root."
    CURRENT_BRANCH=$(git -C "$DIR" symbolic-ref --quiet --short HEAD) || die "Choose a branch in $DIR before installing."
    [ "$CURRENT_BRANCH" = "$BRANCH" ] || die "Keep branch $CURRENT_BRANCH. Set HELM_BRANCH=$CURRENT_BRANCH to install it."
    [ "$(git -C "$DIR" remote get-url origin)" = "$REPO" ] || die "The checkout uses another source. Set HELM_REPO to its origin or choose another folder."
    GIT_DIR=$(git -C "$DIR" rev-parse --absolute-git-dir) || die "Cannot read Git files in $DIR."
    for STATE in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer BISECT_LOG; do
      [ ! -e "$GIT_DIR/$STATE" ] || die "Finish the Git operation in $DIR before installing."
    done
    # These index flags hide edits from status. Refuse them rather than clear
    # the flags or risk building over files Git did not check.
    INDEX_FLAGS=$(git -C "$DIR" ls-files -v) || die "Cannot check tracked files in $DIR."
    while IFS= read -r ENTRY; do
      case "$ENTRY" in
        [a-zS]' '*) die "Some files are hidden from Git status in $DIR. Clear those flags before installing." ;;
      esac
    done <<< "$INDEX_FLAGS"
    STATUS=$(git -C "$DIR" status --porcelain --untracked-files=all --ignore-submodules=none) || die "Cannot check local files in $DIR."
    [ -z "$STATUS" ] || die "Save your edits and move untracked files out of $DIR before installing."
    git -C "$DIR" fetch --quiet --no-tags origin "refs/heads/$BRANCH" || die "Cannot fetch branch $BRANCH."
    TARGET=$(git -C "$DIR" rev-parse --verify FETCH_HEAD)
    if [ "$TARGET" = "$(git -C "$DIR" rev-parse HEAD)" ]; then
      say "$DIR is already current"
    elif git -C "$DIR" merge-base --is-ancestor "$TARGET" HEAD; then
      say "kept local commits in $DIR"
    elif git -C "$DIR" merge-base --is-ancestor HEAD "$TARGET"; then
      git -C "$DIR" -c core.hooksPath=/dev/null merge --ff-only --no-overwrite-ignore --quiet "$TARGET" \
        || die "Cannot update $DIR without changing local files."
      say "updated $DIR"
    else
      die "Local and remote commits differ. Keep them and resolve the branch in $DIR before installing."
    fi
  elif [ -n "$(ls -A "$DIR")" ]; then
    die "The install folder is not an empty folder or a Git checkout: $DIR"
  else
    git clone --quiet --branch "$BRANCH" --depth 1 -- "$REPO" "$DIR"
  fi
else
  git clone --quiet --branch "$BRANCH" --depth 1 -- "$REPO" "$DIR"
fi
[ -f "$DIR/package.json" ] && [ -f "$DIR/package-lock.json" ] || die "The checkout needs package.json and package-lock.json."

# Install terminal software only after the checkout passes all safety checks.
if need herdr || [ -x "$BIN_DIR/herdr" ]; then
  say "herdr $("${BIN_DIR}/herdr" --version 2>/dev/null || herdr --version 2>/dev/null || echo present)"
else
  step "installing herdr (it runs the agent terminals)"
  curl -fsSL https://herdr.dev/install.sh | sh || die "Cannot install herdr. Install it and run this installer again."
  need herdr || [ -x "$BIN_DIR/herdr" ] || die "Cannot find herdr after installation. Install it and run this installer again."
fi

step "installing dependencies"
# Dev dependencies included on purpose: the web app is built from source here,
# and vite lives in devDependencies. Skipping them gets you a working daemon
# and no app to point a phone at.
(cd "$DIR" && npm ci --include=dev --silent --no-fund --no-audit) || die "Cannot install the saved dependencies with npm ci."

step "building the chat reader"
(cd "$DIR" && node scripts/build-log-reader.mjs) || die "could not build the chat reader"

step "building the app"
(cd "$DIR" && npm --workspace @helm/web run build --silent) >/dev/null 2>&1 \
  || die "could not build the web app - run 'npm --workspace @helm/web run build' in $DIR to see why"
say "built apps/web/dist"

# ---------------------------------------------------------------- terminals

# The terminal in the app needs a pty, which is a compiled addon. It ships
# prebuilt binaries, but only up to whatever node ABI was current when it was
# published - node 26 is ABI 147 and the newest prebuilt is 131 - so on a
# recent node there is nothing to load and helm falls back to reading a herdr
# pane's rendered screen on a timer, which is slow enough to notice.
#
# This used to only *report* that, which meant a machine quietly ran on the
# slow path until someone went looking. If there is a compiler here, build
# the thing. It takes about half a minute.
step "checking terminal support"

pty_loads() {
  (cd "$DIR" && node -e 'import("@homebridge/node-pty-prebuilt-multiarch").then(()=>process.exit(0),()=>process.exit(1))') 2>/dev/null
}

PTY_DIR="$DIR/node_modules/@homebridge/node-pty-prebuilt-multiarch"

if pty_loads; then
  say "fast terminals (pty)"
elif (need cc || need gcc || need g++) && need make && need python3 && [ -d "$PTY_DIR" ]; then
  say "no prebuilt pty for $(node -v) - building one (about 30s)"
  if (cd "$PTY_DIR" && npx --yes node-gyp rebuild) >/dev/null 2>&1 && pty_loads; then
    say "fast terminals (pty, compiled here)"
  else
    say "! the pty build failed - terminals will use the slow fallback."
    say "  see why with:  cd $PTY_DIR && npx node-gyp rebuild"
  fi
else
  say "! no pty support - terminals will use the slow fallback."
  say "  it needs a compiler to build one:"
  say "    debian/ubuntu:  sudo apt install -y build-essential python3"
  say "    fedora:         sudo dnf install -y gcc-c++ make python3"
  say "    arch:           sudo pacman -S --needed base-devel python"
  say "  then re-run this installer."
fi

# -------------------------------------------------------------------- link

step "putting helm on your PATH"
mkdir -p "$BIN_DIR"
# Quote literal paths as Bash words. Double quotes alone still allow dollar
# signs, backticks and embedded quotes from an install path to become code.
{
  cat <<'LAUNCHER'
#!/usr/bin/env bash
# herdr can be outside the PATH of a non-login shell.
export PATH="$HOME/.local/bin:$PATH"
LAUNCHER
  printf 'NODE_BIN=%q\n' "$NODE_BIN"
  cat <<'LAUNCHER'
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)" || {
  echo "helm: Cannot find Node. Install Node and run the Helm installer again." >&2
  exit 1
}
LAUNCHER
  printf 'exec "$NODE_BIN" %q "$@"\n' "$DIR/packages/connect/bin/helm.js"
} > "$BIN_DIR/helm"
chmod +x "$BIN_DIR/helm"
say "$BIN_DIR/helm"

case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=yes ;;
  *) ON_PATH=no ;;
esac

# ------------------------------------------------------------------- done

step "starting helm"
"$BIN_DIR/helm" start || die "could not start Helm - run helm start to see why"

printf '\n%s\n' "-------------------------------------------------------------"
if [ "$ON_PATH" = no ]; then
  say "$BIN_DIR is not on your PATH yet. Add this to your shell rc:"
  printf '\n    export PATH="$HOME/.local/bin:$PATH"\n\n'
  say "then open a new shell, or run helm by its full path below."
fi

cat <<'NEXT'
  Helm is installed and active.

  Joining your network:

    helm join

  Paste the private join link from Settings on any paired device. That's it:
  this computer stays connected, and its browser/app opens already signed in.

  To create your first always-on home instead, install Caddy and run helm setup.

  Commands worth remembering:

    helm add controller          a link to open on a phone or browser
    helm add pc                  a private join link for another computer
    helm add vm                  a private join link for another always-on machine
    helm join                    paste the link on the machine being added
    helm open                    open the app here, already signed in
    helm status                  check your machines

  Full VM, HTTPS and phone instructions:

    SETUP.md inside the Helm install folder
NEXT
printf '%s\n\n' "-------------------------------------------------------------"
