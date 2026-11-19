# Remote screens

The engine and viewer come from screen-relay 0.1.2 by Vercel Labs
(https://github.com/vercel-labs/screen-relay), Apache-2.0: see LICENSE.
`src/`, `Makefile`, `packages.tsv` and `viewer/viewer.js` are copied as that
release ships them. Helm's own parts are `viewer/helm.js` and two edits in
`viewer/index.html` (title, hint style). The engine serves only `index.html`
and `viewer.js`, so Helm writes `viewer.js` + `helm.js` as one file into
`~/.helm/screen/viewer` when it starts a screen.

Each machine builds the engine once into `~/.helm/screen`
(packages/connect/src/screen.js). The build links the system's x264
(GPL-2.0-or-later) and libwebsockets.

To take a new release: copy its `src/engine`, `Makefile`, `packages.tsv` and
`dist/viewer/viewer.js` over these, keep `helm.js`, and check that
`window.relayViewer.setViewOnly` still exists.
