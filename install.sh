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

# A lock belongs to the installer process, not to its child build commands.
# Read saved values as data. Never source a recovery record as shell code.
INSTALL_ROOT="$DIR"
JOURNAL="${INSTALL_ROOT}.install-state"
INSTALL_LOCK="${INSTALL_ROOT}.install-lock"
OWN_TRANSACTION=no
STAGE=""

remove_release_record() {
  local SAVED_STAGE=""
  if [ -f "$JOURNAL/stage" ]; then IFS= read -r SAVED_STAGE < "$JOURNAL/stage"; fi
  case "$SAVED_STAGE" in
    "$INSTALL_ROOT".release.*)
      [[ "${SAVED_STAGE#"$INSTALL_ROOT".release.}" =~ ^[0-9]+$ ]] || return 1
      rm -rf -- "$SAVED_STAGE" ;;
    "") ;;
    *) return 1 ;;
  esac
  rm -rf -- "$JOURNAL"
}

recover_release() {
  [ -d "$JOURNAL" ] || return 0
  local PHASE="preparing" OLD NEXT STATUS HEAD_NOW SAVED_BRANCH NOW_BRANCH ITEM EXISTED INDEX=0
  if [ -f "$JOURNAL/phase" ]; then IFS= read -r PHASE < "$JOURNAL/phase"; fi
  case "$PHASE" in
    preparing|complete) remove_release_record; return ;;
    publishing) ;;
    *) say "Cannot read the saved installation. Keep $JOURNAL."; return 1 ;;
  esac
  IFS= read -r OLD < "$JOURNAL/previous" || return 1
  IFS= read -r NEXT < "$JOURNAL/target" || return 1
  [[ "$OLD" =~ ^[0-9a-f]{40,64}$ && "$NEXT" =~ ^[0-9a-f]{40,64}$ ]] || return 1
  IFS= read -r SAVED_BRANCH < "$JOURNAL/branch" || return 1
  NOW_BRANCH=$(git -C "$INSTALL_ROOT" symbolic-ref --quiet --short HEAD) || return 1
  if [ "$NOW_BRANCH" != "$SAVED_BRANCH" ]; then
    say "The selected branch changed. Keep your changes and $JOURNAL."
    return 1
  fi
  HEAD_NOW=$(git -C "$INSTALL_ROOT" rev-parse HEAD) || return 1
  if [ "$HEAD_NOW" != "$OLD" ] && [ "$HEAD_NOW" != "$NEXT" ]; then
    say "The saved version changed. Keep your changes and $JOURNAL."
    return 1
  fi
  # Validate every copy before removing any installed file. Backups remain
  # intact throughout recovery, so a second interruption can be retried.
  while IFS= read -r -d '' ITEM && IFS= read -r -d '' EXISTED; do
    [[ "$ITEM" = node_modules || "$ITEM" = apps/web/dist || "$ITEM" =~ ^(apps|packages)/[^/.][^/]*/node_modules$ || "$ITEM" =~ ^native/log-index/log-index\.[a-zA-Z0-9._-]+\.node$ ]] || return 1
    case "$EXISTED" in
      yes) [ -e "$JOURNAL/files/$INDEX" ] || [ -L "$JOURNAL/files/$INDEX" ] || return 1 ;;
      no) ;;
      *) return 1 ;;
    esac
    INDEX=$((INDEX + 1))
  done < "$JOURNAL/paths"
  [ "$INDEX" -gt 0 ] || return 1
  STATUS=$(git -C "$INSTALL_ROOT" status --porcelain --untracked-files=all --ignore-submodules=none) || return 1
  # Hidden index flags can conceal owner edits. Refuse source rollback too.
  local FLAGS ENTRY
  FLAGS=$(git -C "$INSTALL_ROOT" ls-files -v) || return 1
  while IFS= read -r ENTRY; do
    case "$ENTRY" in [a-zS]' '*) STATUS="hidden edits" ;; esac
  done <<< "$FLAGS"
  if [ -z "$STATUS" ]; then
    git -C "$INSTALL_ROOT" reset --hard --quiet "$OLD" || return 1
  fi
  INDEX=0
  while IFS= read -r -d '' ITEM && IFS= read -r -d '' EXISTED; do
    rm -rf -- "$INSTALL_ROOT/$ITEM" || return 1
    if [ "$EXISTED" = yes ]; then
      mkdir -p "$(dirname "$INSTALL_ROOT/$ITEM")" || return 1
      cp -a -- "$JOURNAL/files/$INDEX" "$INSTALL_ROOT/$ITEM" || return 1
    fi
    INDEX=$((INDEX + 1))
  done < "$JOURNAL/paths"
  if [ -f "$JOURNAL/launcher" ]; then
    mkdir -p "$BIN_DIR" || return 1
    cp -p -- "$JOURNAL/launcher" "$BIN_DIR/helm" || return 1
  elif [ -f "$JOURNAL/no-launcher" ]; then
    rm -- "$BIN_DIR/helm" 2>/dev/null || [ ! -e "$BIN_DIR/helm" ] || return 1
  else
    return 1
  fi
  if [ -n "$STATUS" ]; then
    say "Kept your edits and restored the working app and dependencies."
    say "Keep $JOURNAL. Resolve the saved installation before installing again."
    return 1
  fi
  if [ -f "$JOURNAL/launcher" ]; then
    "$BIN_DIR/helm" start || { say "Cannot restart the previous installation. Keep $JOURNAL."; return 1; }
  fi
  say "Restored the previous installation."
  remove_release_record || return 1
}

cleanup_release() {
  local RESULT=$?
  trap - EXIT
  if [ "$OWN_TRANSACTION" = yes ] && [ -d "$JOURNAL" ]; then
    if [ "$RESULT" = 0 ]; then
      printf 'complete\n' > "$JOURNAL/phase.new"
      mv -- "$JOURNAL/phase.new" "$JOURNAL/phase"
      remove_release_record || RESULT=1
    else
      recover_release || RESULT=1
    fi
  fi
  rm -f -- "$INSTALL_LOCK"
  exit "$RESULT"
}

if ! ln -s "$$" "$INSTALL_LOCK" 2>/dev/null; then
  LOCK_OWNER=$(readlink "$INSTALL_LOCK") || die "Cannot read the installation lock. Keep $INSTALL_LOCK."
  [[ "$LOCK_OWNER" =~ ^[1-9][0-9]*$ ]] || die "Cannot read the installation lock. Keep $INSTALL_LOCK."
  if kill -0 "$LOCK_OWNER" 2>/dev/null; then die "An installer is already running."; fi
  rm -f -- "$INSTALL_LOCK"
  ln -s "$$" "$INSTALL_LOCK" || die "Another installer started. Try again later."
fi
trap cleanup_release EXIT
recover_release || die "Cannot finish installation recovery. Keep the saved files in $JOURNAL."

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
      say "preparing the new release for $DIR"
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

# Check ignored local paths before downloading or building software.
if [ -n "${TARGET:-}" ]; then
  while IFS= read -r -d '' ITEM; do
    if [ -e "$DIR/$ITEM" ] || [ -L "$DIR/$ITEM" ]; then
      git -C "$DIR" ls-files --error-unmatch -- "$ITEM" >/dev/null 2>&1 ||
        die "Cannot update $DIR without changing local files."
    fi
  done < <(git -C "$DIR" diff --name-only --diff-filter=A -z HEAD "$TARGET")
fi

# Keep the serving checkout and its dependencies unchanged during preparation.
LIVE_DIR="$DIR"
PREVIOUS=$(git -C "$LIVE_DIR" rev-parse HEAD)
TARGET="${TARGET:-$PREVIOUS}"
if git -C "$LIVE_DIR" merge-base --is-ancestor "$TARGET" HEAD; then TARGET="$PREVIOUS"; fi
STAGE="${LIVE_DIR}.release.$$"
mkdir -m 700 "$JOURNAL"
OWN_TRANSACTION=yes
mkdir -m 700 "$JOURNAL/files"
printf '%s\n' "$STAGE" > "$JOURNAL/stage"
printf '%s\n' "$PREVIOUS" > "$JOURNAL/previous"
printf '%s\n' "$TARGET" > "$JOURNAL/target"
git -C "$LIVE_DIR" symbolic-ref --quiet --short HEAD > "$JOURNAL/branch"
printf 'preparing\n' > "$JOURNAL/phase"
PATHS=()
git clone --quiet --no-hardlinks --no-checkout -- "$LIVE_DIR" "$STAGE"
git -C "$STAGE" fetch --quiet -- "$LIVE_DIR" "$TARGET"
git -C "$STAGE" checkout --quiet --detach "$TARGET"
DIR="$STAGE"

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

# Check the prepared app before publishing anything.
[ -f "$DIR/apps/web/dist/index.html" ] || die "The new app is missing. Keep the working release."
[ -z "$(git -C "$LIVE_DIR" status --porcelain --untracked-files=all)" ] || die "Save your edits before installing."
[ "$(git -C "$LIVE_DIR" rev-parse HEAD)" = "$PREVIOUS" ] || die "The saved version changed. Run the installer again."
if [ -e "$BIN_DIR/helm" ]; then
  cp -p -- "$BIN_DIR/helm" "$JOURNAL/launcher"
else
  : > "$JOURNAL/no-launcher"
fi
PATHS=(node_modules apps/web/dist)
for ITEM in "$LIVE_DIR"/apps/*/node_modules "$LIVE_DIR"/packages/*/node_modules "$STAGE"/apps/*/node_modules "$STAGE"/packages/*/node_modules "$LIVE_DIR"/native/log-index/log-index.*.node "$STAGE"/native/log-index/log-index.*.node; do
  [ -e "$ITEM" ] || [ -L "$ITEM" ] || continue
  ITEM="${ITEM#"$LIVE_DIR/"}"
  ITEM="${ITEM#"$STAGE/"}"
  case " ${PATHS[*]} " in *" $ITEM "*) ;; *) PATHS+=("$ITEM");; esac
done
# Finish all saved copies before changing source or serving files.
INDEX=0
: > "$JOURNAL/paths"
for ITEM in "${PATHS[@]}"; do
  EXISTED=no
  if [ -e "$LIVE_DIR/$ITEM" ] || [ -L "$LIVE_DIR/$ITEM" ]; then
    cp -a -- "$LIVE_DIR/$ITEM" "$JOURNAL/files/$INDEX"
    EXISTED=yes
  fi
  printf '%s\0%s\0' "$ITEM" "$EXISTED" >> "$JOURNAL/paths"
  INDEX=$((INDEX + 1))
done
[ -z "$(git -C "$LIVE_DIR" status --porcelain --untracked-files=all --ignore-submodules=none)" ] || die "Save your edits before installing."
[ "$(git -C "$LIVE_DIR" rev-parse HEAD)" = "$PREVIOUS" ] || die "The saved version changed. Run the installer again."
printf 'publishing\n' > "$JOURNAL/phase.new"
mv -- "$JOURNAL/phase.new" "$JOURNAL/phase"
# Flush the record and saved files before publication. Do not follow links:
# node_modules can itself link to a development checkout owned by another chat.
node --input-type=module -e '
  import { readdirSync, lstatSync, openSync, fsyncSync, closeSync } from "node:fs";
  import { join, dirname } from "node:path";
  function flush(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of readdirSync(path)) flush(join(path, name));
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  flush(process.argv[1]);
  const parent = openSync(dirname(process.argv[1]), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
' "$JOURNAL" || die "Cannot save installation recovery files."
git -C "$LIVE_DIR" -c core.hooksPath=/dev/null merge --ff-only --no-overwrite-ignore --quiet "$TARGET" \
  || die "Cannot update $LIVE_DIR without changing local files."
for ITEM in "${PATHS[@]}"; do
  rm -rf -- "$LIVE_DIR/$ITEM"
  if [ -e "$STAGE/$ITEM" ] || [ -L "$STAGE/$ITEM" ]; then
    mkdir -p "$(dirname "$LIVE_DIR/$ITEM")"
    cp -a -- "$STAGE/$ITEM" "$LIVE_DIR/$ITEM"
  fi
done
DIR="$LIVE_DIR"

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
