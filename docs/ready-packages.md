# Checked app packages

Helm keeps a source install. Automatic version updates already use Git bundles
from the owner's other machines. They do not fetch GitHub. Keep that path.

The package tool adds a built web app to a full source bundle. It saves build
time on a receiving machine. It does not replace the source installer or carry
Node.js, dependencies, native programs, accounts, machine settings, or keys.
Keep local dependencies installed for the receiving machine.

## Make and send

Run these commands from a clean source checkout. Save the package outside it.

```sh
npm --workspace @helm/web run build
node scripts/ready-package.mjs pack ~/.helm/ready-app
node scripts/ready-package.mjs check ~/.helm/ready-app
node scripts/ready-package.mjs send ~/.helm/ready-app Laptop '~/.helm/incoming-ready-app'
```

The last command uses `helm copy`. It does not restart or update the receiver.
Check an interrupted transfer through Helm before starting another one.
No package comes from an outside download service.

## Receive

Update the receiver's source to the same commit through Helm first. Keep the
source checkout clean. Run these commands in that checkout on the receiver:

```sh
node scripts/ready-package.mjs check ~/.helm/incoming-ready-app
node scripts/ready-package.mjs receive ~/.helm/incoming-ready-app
```

Reload the app after receiving it. Open pages can need a reload because the
package replaces the built app files. Receiving does not change source or run
package code. The source bundle is for inspection and recovery, not automatic
execution. Git can inspect it with `git bundle list-heads` and `git bundle verify`.

The tool checks the complete file list, file sizes, SHA-256 checksums, source
bundle, and build commit. It rejects links, extra files, dirty builds, changed
files, local source edits, and mismatched source versions before replacement.
It stages the replacement beside the current app. A failed final rename restores
the previous app. A power loss during the two renames can still need manual
recovery from the adjacent `dist.backup-*` folder.

Checksums detect damage. They do not prove who sent a package. Accept packages
only from your own trusted machines. The receiver must use its own checked
copy of this tool. Never run tools from an unknown package.

## Evidence and support

| System | Evidence here | Support claim |
| --- | --- | --- |
| Linux x86_64, Node.js 26 | Named package tests, web build, private first-chat check | Checked on this machine |
| Other Linux systems and processor types | No runtime check in this change | Use source install; check locally |
| macOS | No runtime check in this change | Not tested here |
| Native Windows | No runtime check in this change | Not tested here |
| Windows through WSL | No runtime check in this change | Not tested here |

Node.js 22 or newer is required by the source project. This change checks with
Node.js 26; it does not establish a Node.js 22 runtime result. Native dependencies
must match the receiving system. Do not copy `node_modules` between machines.

The private first-chat check uses a free fake agent. It proves the picker,
help, send, and reply path. It does not prove paid-agent sign-in, macOS startup,
native Windows startup, or transfer between physical machines.

Tests: `test/ready-package.test.mjs`, `test/browser/new-chat.test.mjs`.

## Complete Linux artifact assessment

The current dependency folder uses 218 MiB. It contains native programs for
several systems. On this Linux x86_64 machine, Node.js 26.8.1 uses native module
version 147. The installed terminal dependency, `node-pty`, has no matching
binary and fails to load. The `node-datachannel` dependency loads successfully.
The private fake-chat proof uses Helm's available terminal path; it does not
prove that this missing dependency can run on another Linux computer.

A complete installer needs a fixed Node.js version, matching native programs,
a compatible Linux system library baseline, and an isolated startup check of
those exact files. Copying the current dependency folder would not meet that
requirement. The checked web package remains useful with a working source
install. It is not a complete ready-built installer. A separate
[current Linux package](linux-package.md) pins Node.js 22.23.3 and carries
matching dependencies and the terminal runtime.
