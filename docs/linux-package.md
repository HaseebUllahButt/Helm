# Current Linux package

This package carries committed Helm source, its built web app, dependencies,
Node.js 22.23.3, and herdr 0.9.1. It needs no npm install or compiler at startup.
It keeps the source checkout and local machine state separate. It does not
include accounts, keys, or the owner's data folder.

Use only packages from your own trusted machines. The file checks detect damage,
not an untrusted sender. Keep an untouched package folder for those checks;
running the app can change files in its source checkout.

## Make a package

Build the web app from the source commit first. The package tool refuses a
missing, dirty, or mismatched app build. It copies source from Git, so unsaved
source changes do not enter the package. It copies installed dependencies into
a private stage and replaces workspace links with links inside the package.
It never installs packages into a source checkout.

```sh
node scripts/linux-package.mjs create /path/outside/checkout/linux-package /path/to/node-22.23.3/bin/node /path/to/herdr
node scripts/linux-package.mjs check /path/outside/checkout/linux-package
node scripts/linux-package.mjs send /path/outside/checkout/linux-package Laptop '~/.helm/incoming-linux-package'
```

The send command checks the package, then uses `helm copy`. It does not start
or update the receiving machine. Keep the existing install until you check
startup from the new package. Do not overlay a running package folder.

Run `bin/helm` from the received folder. The launcher selects its own Node.js
and herdr binaries. It does not create or start a service by itself. Choose a
private `HELM_DIR` for a first check. Do not point an untested package at live
machine state. Use your existing source install for service setup and source
updates; rebuilding newer source versions still needs npm and build tools.
Replacing a package through Helm copy is a separate manual step.

The package includes a full source bundle, its source checkout, and a file list
with sizes, permissions, link targets, and SHA-256 checksums. Links that leave
the package cause a refusal. The build also checks that both native dependency
modules load with the bundled Node.js.

## Support boundary

This package is for the tested Linux x86_64 machine. Its test host has glibc
2.44. It still needs the operating system's C and C++ libraries, shell, and
normal system programs such as Git. It is not a universal Linux image.
Other Linux versions, macOS, native Windows, and WSL remain untested.
The package does not include a web browser or signed-in coding agents.

The private smoke check relocates the package, launches it through `bin/helm`,
checks native terminal support, sends a first question to a free fake agent,
and runs a command in the terminal. Trap programs reject and record any npm
or compiler call. That proof does not cover paid-agent sign-in, service setup,
physical-machine transfers, or automatic source rebuilds.

Test: `test/linux-package.test.mjs`.
