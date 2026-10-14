# Remote controller performance

The browser lives on the thread's machine alongside its agent. A VM thread
uses the VM's browser; a Laptop thread uses Laptop's browser. The regular
agent CLI connects through that machine's loopback hub, so those actions do
not cross the phone link. `--session` can deliberately target another host.
Browsers are lazy and thread storage stays on that host.

The phone receives chat state and an optional preview. Direct WebRTC is used
when available, with the authenticated hub as fallback. Relaying a Laptop
through VM adds another network hop. No implementation can remove the link's
round-trip delay from a click that must reach a remote machine.

Browser Preview defaults to Auto. It lowers JPEG quality, dimensions and
capture rate when measured delivery slows; this works without Network
Information support. Low data captures at most 640 pixels across and about
one frame per second. Balanced uses 960 pixels and about two frames per
second; Full quality uses 1280 pixels and about five. Text only sends metadata
and owner-requested text, with no preview captures or image downloads for
that viewer. These limits affect the preview, preserving page geometry and
agent actions. Each viewer requests and decodes at most one frame at a time.
Viewer leases adapt to latency within a sixty-second maximum.

Safe chat reads wait for a measured round-trip and payload-delivery grace
period before launching a recovery request. This avoids multiplying healthy but slow history
downloads. The grace period is bounded at eight seconds, preserving fallback
for silent peers; unknown or fast links retain the short recovery deadline.
Messages, approvals and browser actions are never replayed by read fallback.
Latency probes and chat watch renewals remain single-flight when a link is
slow or several reconnect/focus events arrive together.

The app already caches its shell and viewed chat history, uses immutable
hashed bundles, compresses WebSocket text without cross-message compression
state, and catches up history by sequence after reconnect. Those mechanisms
remain in place. Preview traffic shares the connection with normal controls;
Low data or Text only helps most when bandwidth, rather than latency alone,
is the bottleneck.

Regression checks cover delayed preview replies, phone/desktop takeover,
text-only control, unchanged page geometry, viewer expiry, slow reads without
duplicate requests, bounded fallback, and single-flight watch/probe traffic.
These are isolated simulations; they do not establish the condition of a
particular phone's radio, VPN, carrier or route.
