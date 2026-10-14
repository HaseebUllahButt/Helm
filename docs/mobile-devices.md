# Testing mobile apps through Helm

Open **Mobile testing** on the machine hosting your Android device/emulator or iOS
simulator. The **Devices** control in a thread opens the same viewer alongside
that agent. Choose **View** for a running device, or **Start & view** for an
existing stopped emulator/simulator. Tap or drag the image to send touch input;
focus it for keyboard input, or use the text field for longer strings. **Open
app** accepts an installed package/bundle ID or a deep link. **Save screenshot**
downloads the host's current screen to the browser.

Device access uses the existing authenticated Helm RPC connection. A phone can
view a device on Laptop through VM without exposing a device hub port, adding
SSH credentials, or opening a separate public share. Choose the machine with
the actual device tools; the VM does not gain simulator support by proxying it.

## Installed tooling and setup

Helm does not install SDKs, system images, runtimes, npm packages, or AVDs. Readiness
inspects executable paths without launching dependencies. Listing devices invokes
installed ADB/simctl; ADB can lazily start its normal host server at that point.

Android discovery searches PATH, ANDROID_HOME, ANDROID_SDK_ROOT, ~/Android/Sdk,
~/Android/sdk, ~/Library/Android/sdk and the Windows local Android SDK directory.
An Android device requires **Android SDK Platform-Tools** (`adb`). Enable USB
debugging and accept its RSA authorization prompt. `adb devices -l` should show
`device`; Helm displays `unauthorized` and `offline` with reconnect guidance.

Emulators additionally require **Android Emulator** and an existing AVD. Use
Android Studio SDK Manager and Device Manager to install a system image and
create an AVD explicitly. `emulator -list-avds` lists the available definitions.
Helm starts only a selected existing AVD and waits for Android boot completion.
On Linux without a desktop display it uses `-no-window`. Check CPU acceleration
and the AVD in Android Studio if startup times out. Closing the viewer leaves
the emulator/device running.

**iOS simulators require a Mac with full Xcode.** Command Line Tools alone do
not include simulator runtimes. Open Xcode, select its developer directory with
`xcode-select`, install the required simulator runtime in Xcode Settings, and
verify `xcrun simctl list devices available`. Helm uses simctl for listing,
booting, app/deep-link opening and screenshots. Taps, swipes, keyboard input and
accessibility inspection additionally require installed **agent-device**.
Install it explicitly (`npm install -g agent-device`) and verify
`agent-device doctor`. Its first iOS input may build an XCTest runner and take a
few minutes. There is no supported iOS simulator backend on Linux or Windows.

Helm reuses agent-device on PATH or an existing T3 installation under
~/.t3/tools/agent-device/<version> or ~/.t3code/tools/agent-device/<version>.
Set T3CODE_HOME for another T3 base directory. Explicit executable/script
paths can be configured with HELM_DEVICE_ADB, HELM_DEVICE_EMULATOR,
HELM_AGENT_DEVICE and HELM_DEVICE_HUB in the Helm service environment. Tool
paths are reported by `helm device readiness`. Device Hub is detected for
inventory; the built-in viewer uses native screenshots and requires no hub
installation or background stream server.

Native ADB text input supports printable ASCII without `%`; space and shell
metacharacters are quoted before reaching the device. Install agent-device
explicitly for its richer text input. Backend/tool failures remain visible;
input success means the command was sent. Verify the screen after each action.

Builds and app installation remain normal host tasks (`adb install`, Xcode,
Gradle, Expo, etc.). If Metro runs elsewhere, configure the usual forwarding
on the device host. Helm does not automatically build/install your app or
create reverse forwards.

## Agent and terminal access

`helm devices` still means network controllers. The singular `helm device`
command controls mobile test devices. All commands return JSON.

```sh
helm device readiness --machine Laptop
helm device list --machine Laptop
helm device open android:emulator-5554 --machine Laptop
helm device tap android:emulator-5554 120 240 --machine Laptop
helm device swipe android:emulator-5554 120 400 120 100 350 --machine Laptop
helm device type android:emulator-5554 'hello from Helm' --machine Laptop
helm device key android:emulator-5554 home --machine Laptop
helm device launch android:emulator-5554 com.example.app --machine Laptop
helm device launch android:emulator-5554 'myapp://settings' --machine Laptop
helm device screenshot android:emulator-5554 --machine Laptop --output /tmp/screen.png
helm device agent android:emulator-5554 --machine Laptop -- snapshot -i
helm device agent android:emulator-5554 --machine Laptop -- click @e3
helm device agent android:emulator-5554 --machine Laptop -- fill @e5 'hello'
helm device close
```

Use exact IDs from the list: `android:<adb-serial>`, `avd:<avd-name>` for a
stopped emulator, or `ios:<simulator-udid>`. Opening an AVD returns its runtime
`android:<serial>` ID; use that returned ID for subsequent actions. Omit
`--machine` for the local host. `--session <thread-id>` overrides the current
HELM_SESSION_ID/HELM_NATIVE_SESSION association. Opening links the device to
the thread; the owner's Devices panel follows subsequent agent opens. Explicit
screenshot output is saved **on the machine invoking the CLI**, including when
the device host is remote.

Tap/swipe CLI coordinates use screenshot pixels. The iOS backend reads the
simulator's display dimensions/scale and converts those pixels to logical
points before dispatching input, including landscape screenshots. If display
calibration is unavailable it fails visibly; use accessibility snapshot refs
in that case.

Keys on Android include home, back, enter, backspace, menu, power, volume-up
and volume-down. iOS supports home plus enter/backspace through agent-device
text input; simulator-specific unsupported buttons fail clearly. Agent
accessibility commands are pinned to a device and a deterministic thread
session; callers cannot override platform, serial, UDID, daemon or state
paths. Agent daemon state and screenshot temporary files live under
HELM_DIR/devices, separate from existing agent-device/T3 state. Helm starts
agent-device only on the first requested interaction and stops its own daemon
after 60 seconds without agent commands. It never stops a T3-owned daemon.

## Viewing limits

Opening a device captures nothing. A visible, unpaused viewer obtains a
30-second lease and requests its next frame only after the previous RPC and
image decode finish. Capture is limited to at most two frames per second per
device; simultaneous viewers share a capture/cache. Each frame is a PNG of at
most 4 MiB with validated dimensions. There are at most 32 viewer leases,
8 watched devices/captures, and 64 linked threads. There is no unbounded frame
queue or background video encoder. This is a screenshot stream suitable for
UI testing, not high-frame-rate video playback.

Pause, page hiding, unmount and close release the lease. An abrupt connection
loss releases it after expiry; idle cleanup discards cached images. A slow
viewer cannot make a backlog. Commands have timeouts and output caps. Closing
a viewer does not shut down the device or interrupt the running agent.

## Implementation and reference

T3's Oct 13 DeviceService, DeviceToolchain, DeviceHubProxy and agent-device
integration in /home/ubuntu/ref/t3code informed the separation between
readiness, thread/device association, controls and live capture. Helm uses its
own existing RPC instead of adding T3's hub/SSH proxy or installing its pinned
tool packages. [agent-device's official command documentation](https://github.com/callstack/agent-device/blob/main/website/docs/docs/commands.md)
describes the semantic snapshot/press/fill workflow; installed tool help is the
authority for platform/version capabilities.

Availability checked October 14, 2026: VM and Laptop are reachable Linux
hosts. Neither has adb, Android Emulator, agent-device, expo-device-hub or
xcrun on PATH or the inspected SDK/T3 locations. Laptop's Bowser checkout is
present at /home/haseeb/dev/me/github/hellyea/bowser. No SDK was installed, no
physical device was operated, and no production daemon/network was changed.
The haseeb, HomePC and why machines were offline and could not be checked.
Real Android and Mac interaction remain unavailable on these checked hosts;
backend, transport and UI coverage use isolated fixtures.
