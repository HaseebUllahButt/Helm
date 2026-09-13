#!/usr/bin/env bash
#
# helm installer.
#
#   curl -fsSL https://raw.githubusercontent.com/HaseebUllahButt/helm/main/install.sh | bash
#
# Installs helm and everything it needs into your home directory, then tells
# you the one command to run next. Safe to re-run: it updates in place and
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

if need node; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$NODE_MAJOR" -lt 22 ]; then
    die "node 22 or newer is required (found $(node -v)).
    helm uses node's built-in SQLite, which older versions do not have.
    https://nodejs.org  or:  curl -fsSL https://fnm.vercel.app/install | bash"
  fi
  say "node $(node -v)"
else
  die "node 22 or newer is required.
    https://nodejs.org  or:  curl -fsSL https://fnm.vercel.app/install | bash"
fi

# herdr owns the terminals helm drives. Without it helm can talk to your
# machines but cannot run anything on them, so install it now rather than
# letting the first session fail.
if need herdr || [ -x "$BIN_DIR/herdr" ]; then
  say "herdr $("${BIN_DIR}/herdr" --version 2>/dev/null || herdr --version 2>/dev/null || echo present)"
else
  step "installing herdr (it owns the agent terminals)"
  curl -fsSL https://herdr.dev/install.sh | sh || die "could not install herdr - install it yourself and re-run"
fi

# ------------------------------------------------------------------ fetch

step "fetching helm"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" reset --hard --quiet "origin/$BRANCH"
  say "updated $DIR"
else
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$DIR"
  say "cloned into $DIR"
fi

step "installing dependencies"
# Dev dependencies included on purpose: the web app is built from source here,
# and vite lives in devDependencies. Skipping them gets you a working daemon
# and no app to point a phone at.
(cd "$DIR" && npm install --silent --no-fund --no-audit) || die "npm install failed"

step "building the app"
(cd "$DIR" && npm --workspace @helm/web run build --silent) >/dev/null 2>&1 \
  || die "could not build the web app - run 'npm --workspace @helm/web run build' in $DIR to see why"
say "built apps/web/dist"

# -------------------------------------------------------------------- link

step "putting helm on your PATH"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/helm" <<EOF
#!/usr/bin/env bash
# helm needs herdr on PATH, which a non-login shell may not have.
export PATH="\$HOME/.local/bin:\$PATH"
# Prefer the node this was installed with, but fall back to PATH: a version
# manager (fnm, nvm) moves the pinned path on every node upgrade, and a shim
# that dies with "no such file" after one is a broken install.
NODE_BIN="$(command -v node)"
[ -x "\$NODE_BIN" ] || NODE_BIN="\$(command -v node)" || {
  echo "helm: node not found - install Node 22+ and re-run the helm installer" >&2
  exit 1
}
exec "\$NODE_BIN" "$DIR/packages/connect/bin/helm.js" "\$@"
EOF
chmod +x "$BIN_DIR/helm"
say "$BIN_DIR/helm"

case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=yes ;;
  *) ON_PATH=no ;;
esac

# ------------------------------------------------------------------- done

printf '\n%s\n' "-------------------------------------------------------------"
if [ "$ON_PATH" = no ]; then
  say "$BIN_DIR is not on your PATH yet. Add this to your shell rc:"
  printf '\n    export PATH="$HOME/.local/bin:$PATH"\n\n'
  say "then open a new shell, or run helm by its full path below."
fi

cat <<'NEXT'
  helm is installed.

  On your always-on VM, install Caddy, then run:

    helm setup

  It creates a free HTTPS address from the VM's public IP, installs Helm as a
  service, and prints one private link. No website or domain is needed. Open
  that link on your laptop or phone. Keep it private: it can add a new device.

  Commands worth remembering:

    helm link                    make a fresh private device link
    helm add                     make a code for another computer
    helm join <CODE> <VM-URL>    connect that computer to your VM
    helm status                  check your machines

  Full VM, HTTPS, desktop, and phone instructions:

    SETUP.md inside the Helm install folder
NEXT
printf '%s\n\n' "-------------------------------------------------------------"
