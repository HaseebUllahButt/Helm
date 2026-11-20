"use strict";
var relayViewer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // viewer/main.ts
  var main_exports = {};
  __export(main_exports, {
    capsLock: () => capsLock,
    connect: () => connect,
    reset: () => reset,
    setScale: () => setScale,
    setViewOnly: () => setViewOnly,
    socket: () => socket,
    toggleMeta: () => toggleMeta,
    toggleSharp: () => toggleSharp,
    watchDpr: () => watchDpr
  });

  // src/protocol/errors.ts
  var ERROR_REASONS = {
    invalid_input: { class: "usage", code: "INVALID_ARGUMENT", exitCode: 2 },
    invalid_option: { class: "usage", code: "INVALID_ARGUMENT", exitCode: 2 },
    unknown_command: { class: "usage", code: "INVALID_ARGUMENT", exitCode: 2 },
    missing_input: { class: "missing_input", code: "INVALID_ARGUMENT", exitCode: 2 },
    missing_command: { class: "missing_input", code: "INVALID_ARGUMENT", exitCode: 2 },
    not_found: { class: "not_found", code: "NOT_FOUND", exitCode: 1 },
    not_running: { class: "not_found", code: "NOT_FOUND", exitCode: 1 },
    already_running: { class: "conflict", code: "BUSY", exitCode: 1 },
    port_in_use: { class: "conflict", code: "BUSY", exitCode: 1 },
    busy: { class: "conflict", code: "BUSY", exitCode: 1 },
    unreachable: { class: "network", code: "NETWORK_ERROR", exitCode: 1 },
    timeout: { class: "network", code: "TIMEOUT", exitCode: 1 },
    disconnected: { class: "network", code: "DISCONNECTED", exitCode: 1 },
    unauthorized: { class: "permission", code: "UNAUTHORIZED", exitCode: 1 },
    forbidden: { class: "permission", code: "UNAUTHORIZED", exitCode: 1 },
    unsupported_input: { class: "platform", code: "UNSUPPORTED", exitCode: 1 },
    unsupported_platform: { class: "platform", code: "UNSUPPORTED", exitCode: 1 },
    missing_dependency: { class: "platform", code: "UNSUPPORTED", exitCode: 1 },
    component_failed: { class: "platform", code: "HTTP_ERROR", exitCode: 1 },
    spawn_failed: { class: "platform", code: "IO_ERROR", exitCode: 1 },
    io_error: { class: "platform", code: "IO_ERROR", exitCode: 1 },
    protocol_error: { class: "platform", code: "PROTOCOL_ERROR", exitCode: 1 },
    invalid_config: { class: "config", code: "CONFIG_ERROR", exitCode: 1 },
    internal: { class: "bug", code: "INTERNAL", exitCode: 1 },
    canceled: { class: "canceled", code: "CANCELED", exitCode: 130 }
  };
  var LEGACY_REASONS = {
    INVALID_ARGUMENT: "invalid_input",
    NOT_FOUND: "not_found",
    BUSY: "busy",
    NETWORK_ERROR: "unreachable",
    TIMEOUT: "timeout",
    DISCONNECTED: "disconnected",
    UNAUTHORIZED: "unauthorized",
    UNSUPPORTED: "unsupported_input",
    HTTP_ERROR: "component_failed",
    IO_ERROR: "io_error",
    PROTOCOL_ERROR: "protocol_error",
    CONFIG_ERROR: "invalid_config",
    INTERNAL: "internal",
    CANCELED: "canceled"
  };
  var RelayError = class extends Error {
    constructor(reason, message, options = {}) {
      super(message);
      __publicField(this, "code");
      __publicField(this, "reason");
      __publicField(this, "class");
      __publicField(this, "exitCode");
      __publicField(this, "hint");
      __publicField(this, "data");
      __publicField(this, "next");
      __publicField(this, "status");
      __publicField(this, "label");
      this.name = "RelayError";
      this.reason = Object.hasOwn(ERROR_REASONS, reason) ? reason : Object.hasOwn(LEGACY_REASONS, reason) ? LEGACY_REASONS[reason] : "internal";
      const definition = ERROR_REASONS[this.reason];
      this.code = definition.code;
      this.class = definition.class;
      this.exitCode = definition.exitCode;
      const details = typeof options === "string" ? { hint: options } : options;
      this.hint = details.hint;
      this.data = details.data;
      this.next = details.next;
      this.label = details.label;
      this.status = details.status ?? "error";
    }
  };

  // src/protocol/index.ts
  var MAGIC = 1314081841;
  var VERSION = 1;
  var HEADER_SIZE = 20;
  var INPUT_SIZE = 16;
  var MAX_BYTES_IN_FLIGHT = 8388608;
  var SUBPROTOCOL = "nsl1";
  var MESSAGE_TYPES = { frame: 1, ack: 2, input: 3, controlReady: 4, inputResponse: 5, cursor: 6 };
  var INPUT_TYPES = { keyDown: 1, keyUp: 2, pointerMove: 3, buttonDown: 4, buttonUp: 5, wheel: 6, releaseAll: 7, text: 8 };
  function integer(value, min, max, name) {
    if (!Number.isInteger(value) || value < min || value > max) throw new RelayError("invalid_input", `Invalid ${name}`);
    return value;
  }
  function coordinate(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new RelayError("invalid_input", `Invalid ${name}`);
    return Math.round(value * 65535);
  }
  function encodeInputRecord(event) {
    if (!event || typeof event !== "object" || !Object.hasOwn(INPUT_TYPES, event.type)) throw new RelayError("invalid_input", "Unknown input type");
    const bytes = new Uint8Array(INPUT_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, INPUT_TYPES[event.type]);
    const buttons2 = integer(event.buttons ?? 0, 0, 31, "buttons");
    const modifiers2 = integer(event.modifiers ?? 0, 0, 255, "modifiers");
    if ((event.type === "releaseAll" || event.type === "text") && (buttons2 || modifiers2)) throw new RelayError("invalid_input", "Release and text events require zero masks");
    view.setUint16(12, buttons2);
    view.setUint16(14, modifiers2);
    if (event.type === "pointerMove" || event.type === "buttonDown" || event.type === "buttonUp" || event.type === "wheel") {
      view.setUint16(8, coordinate(event.x, "x"));
      view.setUint16(10, coordinate(event.y, "y"));
    }
    if (event.type === "keyDown" || event.type === "keyUp") view.setUint16(2, integer(event.key, 0, 231, "key"));
    if (event.type === "buttonDown" || event.type === "buttonUp") view.setUint16(2, integer(event.button, 1, 3, "button"));
    if (event.type === "wheel") {
      if (event.axis !== "vertical" && event.axis !== "horizontal") throw new RelayError("invalid_input", "Invalid wheel axis");
      const delta = integer(event.delta, -1200, 1200, "wheel delta");
      if (delta % 120) throw new RelayError("invalid_input", "Wheel delta must be a multiple of 120");
      view.setUint16(2, event.axis === "horizontal" ? 1 : 0);
      view.setInt32(4, delta);
    }
    if (event.type === "text") {
      const codepoint = integer(event.codepoint, 1, 1114111, "Unicode scalar");
      if (codepoint >= 55296 && codepoint <= 57343) throw new RelayError("invalid_input", "Invalid Unicode scalar");
      view.setInt32(4, codepoint);
      view.setUint16(8, 0);
      view.setUint16(10, 0);
    }
    return bytes;
  }
  function header(type, generation2, sequence2, size) {
    integer(type, 1, 6, "message type");
    integer(generation2, 1, 4294967295, "generation");
    integer(sequence2, 0, 4294967295, "sequence");
    integer(size, 0, 8388620, "payload length");
    const bytes = new Uint8Array(HEADER_SIZE + size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, MAGIC);
    view.setUint8(4, VERSION);
    view.setUint8(5, type);
    view.setUint32(8, generation2);
    view.setUint32(12, sequence2);
    view.setUint32(16, size);
    return bytes;
  }
  function encodeInput(event, generation2, sequence2) {
    const bytes = header(MESSAGE_TYPES.input, generation2, sequence2, INPUT_SIZE);
    bytes.set(encodeInputRecord(event), HEADER_SIZE);
    return bytes;
  }
  function encodeAck(generation2, sequence2, viewerWaitMs) {
    if (viewerWaitMs === void 0) return header(MESSAGE_TYPES.ack, generation2, sequence2, 0);
    const bytes = header(MESSAGE_TYPES.ack, generation2, sequence2, 4);
    const micros = Number.isFinite(viewerWaitMs) ? Math.min(4294967295, Math.max(0, Math.round(viewerWaitMs * 1e3))) : 0;
    new DataView(bytes.buffer).setUint32(HEADER_SIZE, micros);
    return bytes;
  }
  function parseHeader(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.byteLength < HEADER_SIZE || data.byteLength > HEADER_SIZE + 12 + MAX_BYTES_IN_FLIGHT) throw new RelayError("protocol_error", "Invalid message length");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = view.getUint8(5), flags = view.getUint16(6), generation2 = view.getUint32(8);
    if (view.getUint32(0) !== MAGIC || view.getUint8(4) !== VERSION || type < 1 || type > 6 || flags > (type === MESSAGE_TYPES.frame ? 1 : 0) || !generation2 || view.getUint32(16) !== data.byteLength - HEADER_SIZE) {
      throw new RelayError("protocol_error", "Invalid message envelope");
    }
    return { type, flags, generation: generation2, sequence: view.getUint32(12), payloadLength: view.getUint32(16) };
  }
  function parseMessage(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const { type, flags, generation: generation2, sequence: sequence2, payloadLength: size } = parseHeader(data);
    const view = new DataView(data.buffer, data.byteOffset + HEADER_SIZE, size);
    const invalid = (what) => new RelayError("protocol_error", `Invalid ${what}`);
    if (type === MESSAGE_TYPES.frame) {
      if (size < 13 || !sequence2) throw invalid("frame header");
      const width = view.getUint16(0), height = view.getUint16(2), timestamp = view.getBigUint64(4);
      if (!width || !height || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("frame header");
      return { type: "frame", generation: generation2, sequence: sequence2, keyframe: flags === 1, width, height, timestamp: Number(timestamp), data: data.subarray(HEADER_SIZE + 12) };
    }
    if (type === MESSAGE_TYPES.cursor) {
      if (size < 8 || sequence2) throw invalid("cursor envelope");
      const width = view.getUint16(0), height = view.getUint16(2), hotX = view.getUint16(4), hotY = view.getUint16(6);
      if (width > 256 || height > 256 || size !== 8 + width * height * 4 || (width && height ? hotX >= width || hotY >= height : width || height || hotX || hotY)) throw invalid("cursor image");
      return { type: "cursor", generation: generation2, width, height, hotX, hotY, pixels: new Uint8ClampedArray(data.buffer, data.byteOffset + HEADER_SIZE + 8, size - 8) };
    }
    if (type === MESSAGE_TYPES.controlReady) {
      if (size !== 4 || sequence2 || !view.getUint16(0) || !view.getUint16(2)) throw invalid("ready message");
      return { type: "controlReady", generation: generation2, width: view.getUint16(0), height: view.getUint16(2) };
    }
    if (type === MESSAGE_TYPES.inputResponse) {
      if (size !== 1 || !sequence2 || view.getUint8(0) > 2) throw invalid("input response");
      return { type: "inputResponse", generation: generation2, sequence: sequence2, status: view.getUint8(0) };
    }
    throw invalid("message type");
  }
  function h264Codec(bytes) {
    for (let i = 0; i + 7 < bytes.length; i++) {
      let n = 0;
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) n = i + 3;
      else if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) n = i + 4;
      if (n && n + 3 < bytes.length && (bytes[n] & 31) === 7) {
        return `avc1.${[bytes[n + 1], bytes[n + 2], bytes[n + 3]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      }
    }
    throw new RelayError("protocol_error", "Keyframe is missing SPS");
  }
  function socketTarget(origin, path, token) {
    const url = new URL(path, origin);
    url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    return { url, protocols: token ? [SUBPROTOCOL, `bearer.${token}`] : [SUBPROTOCOL] };
  }
  var HID_KEYS = {};
  function assignKeys(first, names) {
    names.forEach((name, index) => {
      HID_KEYS[name] = first + index;
    });
  }
  assignKeys(4, Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`));
  assignKeys(30, "Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0".split(" "));
  assignKeys(40, "Enter Escape Backspace Tab Space Minus Equal BracketLeft BracketRight Backslash".split(" "));
  assignKeys(51, "Semicolon Quote Backquote Comma Period Slash CapsLock".split(" "));
  assignKeys(58, Array.from({ length: 12 }, (_, index) => `F${index + 1}`));
  assignKeys(70, "PrintScreen ScrollLock Pause Insert Home PageUp Delete End PageDown ArrowRight ArrowLeft ArrowDown ArrowUp NumLock".split(" "));
  assignKeys(84, "NumpadDivide NumpadMultiply NumpadSubtract NumpadAdd NumpadEnter Numpad1 Numpad2 Numpad3 Numpad4 Numpad5 Numpad6 Numpad7 Numpad8 Numpad9 Numpad0 NumpadDecimal".split(" "));
  HID_KEYS.IntlBackslash = 100;
  HID_KEYS.ContextMenu = 101;
  assignKeys(104, Array.from({ length: 12 }, (_, index) => `F${index + 13}`));
  assignKeys(224, "ControlLeft ShiftLeft AltLeft MetaLeft ControlRight ShiftRight AltRight MetaRight".split(" "));
  Object.freeze(HID_KEYS);
  var MODIFIERS = Object.freeze({ ctrl: 224, control: 224, shift: 225, alt: 226, super: 227, meta: 227, cmd: 227, win: 227 });
  var NAMED_KEYS = Object.freeze({
    ...Object.fromEntries(Object.entries(HID_KEYS).filter(([name]) => !name.startsWith("Key") && !name.startsWith("Digit")).map(([name, code]) => [name.toLowerCase(), code])),
    return: 40,
    esc: 41,
    right: 79,
    left: 80,
    down: 81,
    up: 82,
    menu: 101
  });
  function isLoopback(hostname) {
    return hostname === "localhost" || hostname === "127.0.0.1";
  }
  function validToken(token) {
    return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
  }

  // viewer/main.ts
  var keys = HID_KEYS;
  var canvas = document.querySelector("#screen");
  var ctx = canvas.getContext("2d");
  var status = document.querySelector("#status");
  var cursor = document.querySelector("#cursor");
  var cursorContext = cursor.getContext("2d");
  var accessToken = "";
  var trustedPage = location.protocol === "https:" || isLoopback(location.hostname);
  {
    const fragmentToken = new URLSearchParams(location.hash.slice(1)).get("token");
    if (fragmentToken !== null) {
      history.replaceState(null, "", location.pathname + location.search);
      if (validToken(fragmentToken) && trustedPage) accessToken = document.querySelector("#access-token").value = fragmentToken;
    }
  }
  var cursorAvailable = false;
  var cursorHotX = 0;
  var cursorHotY = 0;
  var pointerPosition;
  function renderCursor() {
    canvas.style.cursor = cursorAvailable && ready ? "none" : "default";
    const r = canvas.getBoundingClientRect(), p = pointerPosition;
    cursor.hidden = !cursorAvailable || !ready || !p || p.pointerType === "touch" || p.clientX < r.left || p.clientX >= r.right || p.clientY < r.top || p.clientY >= r.bottom;
    if (cursor.hidden) return;
    const sx = r.width / canvas.width, sy = r.height / canvas.height;
    cursor.style.width = `${cursor.width * sx}px`;
    cursor.style.height = `${cursor.height * sy}px`;
    cursor.style.left = `${p.clientX - cursorHotX * sx}px`;
    cursor.style.top = `${p.clientY - cursorHotY * sy}px`;
  }
  function receiveCursor({ generation: gen, width, height, hotX, hotY, pixels }) {
    if (!generation || gen !== generation) throw new Error("Invalid cursor envelope");
    cursorAvailable = width > 0;
    cursorHotX = hotX;
    cursorHotY = hotY;
    cursor.width = width || 1;
    cursor.height = height || 1;
    if (cursorAvailable) cursorContext.putImageData(new ImageData(pixels, width, height), 0, 0);
    renderCursor();
  }
  var stats = window.nativeStats = {
    received: 0,
    drawn: 0,
    superseded: 0,
    holdMs: 0,
    bytes: 0,
    decodeerrors: 0,
    outstanding: 0,
    pendingBytes: 0,
    pendingHighWater: 0
  };
  var socket;
  var decoder;
  var retryTimer;
  var deadline;
  var frameHandle = 0;
  var drawnThisFrame = false;
  var transportBroken = false;
  var generation = 0;
  var sequence = 0;
  var lastTimestamp = -1;
  var ready = false;
  var retry = 0;
  var epoch = 0;
  var backlogSince = null;
  var lastCatchUp = -Infinity;
  var CLOCK_WINDOW_MS = 5e3;
  var JITTER_WINDOW_MS = 2e3;
  var JITTER_QUANTILE = 0.95;
  var MAX_HOLD_MS = 100;
  var HOLD_DECAY = 0.05;
  var CLOCK_JUMP_MS = 500;
  var samples = [];
  var lows = [];
  var holdMs = 0;
  var buttons = 0;
  var modifiers = 0;
  var x = 0;
  var y = 0;
  var viewOnly = true;
  var capsLock = false;
  var metaAsCtrl = stored("relay.metaCtrl") === null ? macos() : stored("relay.metaCtrl") === "1";
  var pending = /* @__PURE__ */ new Map();
  var decoded = [];
  var held = /* @__PURE__ */ new Set();
  var latched = /* @__PURE__ */ new Map();
  var clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function setStatus(message) {
    if (status.textContent !== message) status.textContent = message;
  }
  function macos() {
    const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "";
    return platform === "macOS" || platform === "MacIntel";
  }
  var SWAP_META_CONTROL = { 224: 227, 227: 224, 228: 231, 231: 228 };
  function mapKey(code) {
    return metaAsCtrl ? SWAP_META_CONTROL[code] ?? code : code;
  }
  function setModifier(code, down) {
    if (code < 224 || code > 231) return;
    modifiers = down ? modifiers | 1 << code - 224 : modifiers & ~(1 << code - 224);
  }
  function syncCaps(event) {
    if (viewOnly) return;
    const local = event.getModifierState("CapsLock");
    if (local === capsLock) return;
    if (sendInput({ type: "keyDown", key: keys.CapsLock }) && sendInput({ type: "keyUp", key: keys.CapsLock })) capsLock = local;
  }
  function clearLatched() {
    for (const button of latched.values()) button.setAttribute("aria-pressed", "false");
    latched.clear();
  }
  function releaseLatched() {
    for (const code of latched.keys()) releaseKey(code);
    clearLatched();
  }
  var authHeaders = () => accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  function sendInput(event) {
    if (!ready || socket?.readyState !== WebSocket.OPEN || viewOnly && event.type !== "releaseAll") return false;
    socket.send(encodeInput({ ...event, buttons, modifiers }, generation, 0));
    return true;
  }
  function holdKey(code) {
    setModifier(code, true);
    if (sendInput({ type: "keyDown", key: code })) return true;
    setModifier(code, false);
    return false;
  }
  function releaseKey(code) {
    setModifier(code, false);
    sendInput({ type: "keyUp", key: code });
  }
  function dropLatch(code) {
    const button = latched.get(code);
    if (!button) return false;
    latched.delete(code);
    button.setAttribute("aria-pressed", "false");
    releaseKey(code);
    return true;
  }
  function release() {
    buttons = modifiers = 0;
    if (ready) sendInput({ type: "releaseAll" });
    held.clear();
    clearLatched();
  }
  function reset() {
    release();
    ready = false;
    cursorAvailable = false;
    cursor.width = cursor.height = 1;
    renderCursor();
    clearTimeout(deadline);
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
    drawnThisFrame = false;
    backlogSince = null;
    lastCatchUp = -Infinity;
    samples = [];
    lows = [];
    holdMs = stats.holdMs = 0;
    pending.clear();
    for (const item of decoded) item.frame.close();
    decoded.length = 0;
    stats.outstanding = 0;
    stats.pendingBytes = 0;
    generation = 0;
    capsLock = false;
    sequence = 0;
    lastTimestamp = -1;
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = void 0;
  }
  function fail(message) {
    stats.decodeerrors++;
    setStatus(message);
    const old = socket;
    reset();
    if (old && old.readyState < WebSocket.CLOSING) old.close();
  }
  function watchPending(current) {
    clearTimeout(deadline);
    const oldest = pending.values().next().value;
    if (oldest) {
      deadline = setTimeout(() => {
        if (current === epoch) fail("Decoder timed out; reconnecting");
      }, Math.max(0, oldest.arrived + 5e3 - performance.now()));
    }
  }
  function observeArrival(timestamp, arrivedMs) {
    const offset = arrivedMs - timestamp / 1e3, last = samples.at(-1);
    if (last && Math.abs(offset - last.offset) > CLOCK_JUMP_MS) {
      samples = [];
      lows = [];
      holdMs = 0;
    }
    const previous = samples.at(-1)?.time ?? arrivedMs, sample = { time: arrivedMs, offset, late: 0 };
    samples.push(sample);
    while (lows.length && lows[lows.length - 1].offset >= offset) lows.pop();
    lows.push(sample);
    while (samples[0].time < arrivedMs - CLOCK_WINDOW_MS) {
      if (lows[0] === samples[0]) lows.shift();
      samples.shift();
    }
    const base = lows[0].offset, recent = [];
    sample.late = offset - base;
    for (let i = samples.length - 1; i >= 0 && samples[i].time >= arrivedMs - JITTER_WINDOW_MS; i--) recent.push(samples[i].late);
    recent.sort((a, b) => a - b);
    const target = Math.min(MAX_HOLD_MS, recent[Math.floor(JITTER_QUANTILE * (recent.length - 1))]);
    holdMs = target >= holdMs ? target : Math.max(target, holdMs - (arrivedMs - previous) * HOLD_DECAY);
    stats.holdMs = holdMs;
    return base;
  }
  function isDue(item, now) {
    return item.timestamp / 1e3 + item.base + holdMs <= now + 1e-6;
  }
  function dueCount(now) {
    let count = 0;
    while (count < decoded.length && isDue(decoded[count], now)) count++;
    return count;
  }
  function schedulePresent() {
    if (!frameHandle) frameHandle = requestAnimationFrame(present);
  }
  function ackFrame(item) {
    try {
      if (socket?.readyState !== WebSocket.OPEN) throw new Error("Connection closed before ACK");
      socket.send(encodeAck(item.gen, item.seq, performance.now() - item.arrived));
      return true;
    } catch (error) {
      fail(`ACK failed: ${error.message}`);
      return false;
    }
  }
  function retireDecoded() {
    if (transportBroken || socket?.readyState !== WebSocket.OPEN) return;
    for (const item of decoded) if (!ackFrame(item)) break;
  }
  function draw(item) {
    try {
      if (item.gen !== generation) throw new Error("Stale decoded frame");
      ctx.drawImage(item.frame, 0, 0, canvas.width, canvas.height);
    } catch (error) {
      item.frame.close();
      fail(`Draw failed: ${error.message}`);
      return false;
    }
    item.frame.close();
    stats.drawn++;
    const wasReady = ready;
    ready = true;
    if (!wasReady) renderCursor();
    retry = 0;
    setStatus(viewOnly ? "Live \xB7 view only" : "Live \xB7 you have control");
    drawnThisFrame = true;
    return ackFrame(item);
  }
  function presenterPhase(due, draws, backlogMs, sinceCatchUpMs, headOverstayMs) {
    if (due <= 2) return "idle";
    if (due > 12 || headOverstayMs > 200) return "overrun";
    if (due - draws <= 2) return "idle";
    return backlogMs < 500 || sinceCatchUpMs < 250 ? "backlog" : "catchUp";
  }
  function trimDecoded(now, draws = 0) {
    let due = dueCount(now);
    const phase = presenterPhase(
      due,
      draws,
      now - (backlogSince ?? now),
      now - lastCatchUp,
      decoded.length ? now - decoded[0].arrived - holdMs : 0
    );
    if (phase === "idle") {
      backlogSince = null;
      return true;
    }
    backlogSince ?? (backlogSince = now);
    if (phase === "backlog") return true;
    do {
      const dropped = decoded.shift();
      dropped.frame.close();
      stats.superseded++;
      due--;
      if (!ackFrame(dropped)) return false;
    } while (phase === "overrun" && due > 2);
    if (due <= 2) backlogSince = null;
    if (phase === "catchUp") lastCatchUp = now;
    return true;
  }
  function presentDecoded(item) {
    const now = performance.now(), immediate = !decoded.length && !drawnThisFrame;
    decoded.push(item);
    if (!trimDecoded(now)) return false;
    if (immediate && isDue(decoded[0], now) && !draw(decoded.shift())) return false;
    schedulePresent();
    return true;
  }
  function present() {
    frameHandle = 0;
    drawnThisFrame = false;
    const now = performance.now();
    if (!trimDecoded(now, 1)) return;
    let drew = false;
    if (decoded.length && isDue(decoded[0], now)) {
      if (!draw(decoded.shift())) return;
      drew = true;
    }
    if (drew || decoded.length) schedulePresent();
  }
  function connect() {
    clearTimeout(retryTimer);
    epoch++;
    const current = epoch;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      release();
      retireDecoded();
      socket.close();
    }
    reset();
    setStatus("Connecting\u2026");
    if (!("VideoDecoder" in window) || !("EncodedVideoChunk" in window)) {
      setStatus("WebCodecs unavailable in this browser");
      return;
    }
    const target = socketTarget(new URL(`${location.protocol}//${location.host}`), viewOnly ? "/stream?view=1" : "/stream", accessToken);
    socket = new WebSocket(target.url, target.protocols);
    transportBroken = false;
    loadCapabilities();
    const ws = socket;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (current === epoch) {
        setStatus("Waiting for frame\u2026");
        deadline = setTimeout(() => {
          if (current === epoch) fail("First frame timed out; reconnecting");
        }, 5e3);
      }
    };
    ws.onmessage = (e) => {
      if (current !== epoch || ws.readyState !== WebSocket.OPEN) return;
      try {
        if (!(e.data instanceof ArrayBuffer)) throw new Error("Invalid frame length");
        const message = parseMessage(e.data);
        if (message.type === "cursor") {
          receiveCursor(message);
          return;
        }
        if (message.type !== "frame") throw new Error("Invalid frame header");
        const { generation: gen, sequence: seq, keyframe, width, height, timestamp, data } = message;
        if (generation && gen < generation) throw new Error("Stale generation");
        if (gen !== generation) {
          reset();
          generation = gen;
          if (!keyframe || seq !== 1) {
            throw new Error("Generation must start with a keyframe");
          }
        }
        if (seq !== sequence + 1 || timestamp <= lastTimestamp || pending.size >= 360 || stats.pendingBytes + data.byteLength > MAX_BYTES_IN_FLIGHT) throw new Error("Unexpected frame sequence or queue limit");
        sequence = seq;
        lastTimestamp = timestamp;
        stats.received++;
        stats.bytes += data.byteLength;
        const arrived = performance.now();
        pending.set(timestamp, { gen, seq, bytes: data.byteLength, arrived, timestamp, base: observeArrival(timestamp, arrived) });
        stats.outstanding = pending.size;
        stats.pendingBytes += data.byteLength;
        stats.pendingHighWater = Math.max(stats.pendingHighWater, pending.size);
        watchPending(current);
        if (!decoder) {
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            canvas.style.setProperty("--w", String(width));
            canvas.style.setProperty("--h", String(height));
            syncSize();
          }
          const config = { codec: h264Codec(data), codedWidth: width, codedHeight: height, optimizeForLatency: true };
          const instance = new VideoDecoder({
            output(frame) {
              let retained = false;
              try {
                if (current !== epoch || decoder !== instance) return;
                const item = pending.get(frame.timestamp);
                if (!item || item.gen !== generation) {
                  throw new Error("Unexpected decoded frame");
                }
                retained = true;
                pending.delete(frame.timestamp);
                stats.pendingBytes -= item.bytes;
                stats.outstanding = pending.size;
                item.frame = frame;
                if (!presentDecoded(item)) return;
                watchPending(current);
              } catch (error) {
                fail(`Draw failed: ${error.message}`);
              } finally {
                if (!retained) frame.close();
              }
            },
            error(error) {
              if (current === epoch && decoder === instance) fail(`Decode failed: ${error.message}`);
            }
          });
          decoder = instance;
          decoder.configure(config);
        }
        decoder.decode(
          new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp, data })
        );
      } catch (error) {
        if (current === epoch) fail(error.message);
      }
    };
    ws.onerror = () => {
      if (current === epoch) {
        transportBroken = true;
        setStatus("Connection error");
      }
    };
    ws.onclose = () => {
      if (current !== epoch) return;
      reset();
      if (document.hidden) {
        setStatus("Paused while hidden");
        return;
      }
      if (retry >= 5) {
        setStatus(status.textContent + " \xB7 reconnect manually");
        return;
      }
      const delay = Math.min(1e3 * 2 ** retry++, 8e3);
      setStatus(status.textContent + ` \xB7 retrying in ${delay / 1e3}s`);
      retryTimer = setTimeout(connect, delay);
      checkAccess(current);
    };
  }
  function position(e) {
    pointerPosition = { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType };
    renderCursor();
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const px = clamp(Math.floor((e.clientX - r.left) * canvas.width / r.width), 0, canvas.width - 1);
    const py = clamp(Math.floor((e.clientY - r.top) * canvas.height / r.height), 0, canvas.height - 1);
    x = px / (canvas.width - 1);
    y = py / (canvas.height - 1);
  }
  canvas.addEventListener("keydown", (e) => {
    const code = mapKey(keys[e.code]);
    if (!code) return;
    e.preventDefault();
    syncCaps(e);
    if (e.code === "CapsLock") return;
    if (e.repeat || held.has(code)) return;
    if (!holdKey(code)) return;
    held.add(code);
    if (code < 224) releaseLatched();
  });
  canvas.addEventListener("keyup", (e) => {
    const code = mapKey(keys[e.code]);
    if (!code) return;
    e.preventDefault();
    syncCaps(e);
    if (e.code === "CapsLock") return;
    if (!held.delete(code)) return;
    if (!dropLatch(code)) releaseKey(code);
  });
  canvas.addEventListener("pointermove", (e) => {
    position(e);
    sendInput({ type: "pointerMove", x, y });
  });
  canvas.addEventListener("pointerleave", () => {
    pointerPosition = null;
    renderCursor();
  });
  new ResizeObserver(renderCursor).observe(canvas);
  window.addEventListener("scroll", renderCursor, { passive: true });
  var buttonMap = { 0: 1, 1: 2, 2: 3 };
  canvas.addEventListener("pointerdown", (e) => {
    const button = buttonMap[e.button];
    if (!button) return;
    e.preventDefault();
    canvas.focus();
    position(e);
    buttons |= 1 << button - 1;
    canvas.setPointerCapture(e.pointerId);
    sendInput({ type: "buttonDown", button, x, y });
  });
  canvas.addEventListener("pointerup", (e) => {
    const button = buttonMap[e.button];
    if (!button) return;
    e.preventDefault();
    position(e);
    buttons &= ~(1 << button - 1);
    sendInput({ type: "buttonUp", button, x, y });
    if (!buttons && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("lostpointercapture", () => {
    if (buttons) release();
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  var WHEEL_LINES_PER_NOTCH = 3;
  var WHEEL_PIXELS_PER_NOTCH = 100;
  var wheelRemainder = [0, 0];
  function wheelNotches(e, axis) {
    const legacy = axis ? e.wheelDeltaX : e.wheelDeltaY;
    if (typeof legacy === "number" && legacy !== 0) return -legacy / 120;
    const delta = axis ? e.deltaX : e.deltaY;
    if (e.deltaMode === 1) return delta / WHEEL_LINES_PER_NOTCH;
    if (e.deltaMode === 2) return delta;
    return delta / WHEEL_PIXELS_PER_NOTCH;
  }
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    position(e);
    for (const axis of [0, 1]) {
      if (!(axis ? e.deltaX : e.deltaY)) continue;
      const notches = wheelNotches(e, axis);
      if (Math.sign(notches) !== Math.sign(wheelRemainder[axis])) wheelRemainder[axis] = 0;
      wheelRemainder[axis] += notches;
      const whole = Math.trunc(wheelRemainder[axis]);
      if (!whole) continue;
      wheelRemainder[axis] -= whole;
      sendInput({ type: "wheel", axis: axis ? "horizontal" : "vertical", delta: clamp(whole * 120, -1200, 1200), x, y });
    }
  }, { passive: false });
  canvas.addEventListener("blur", release);
  window.addEventListener("blur", () => {
    release();
    pointerPosition = null;
    renderCursor();
  });
  var METRICS_UNAVAILABLE = "Cgroup CPU (one core): unavailable \xB7 Cgroup RAM: unavailable";
  var hudTimer;
  var metricsRequest;
  var configuredFps = 0;
  function hudText(fps, mbps, metrics) {
    const stream = `Stream ${canvas.width}x${canvas.height}${configuredFps ? ` @ ${configuredFps} fps` : ""}`;
    return `${stream} \xB7 Drawn FPS: ${fps.toFixed(1)} \xB7 Stream Mbps: ${mbps.toFixed(2)} \xB7 ${metrics}`;
  }
  function loadCapabilities() {
    fetch("/capabilities", { cache: "no-store", redirect: "error", headers: authHeaders() }).then((response) => response.ok ? response.json() : null).then((data) => {
      if (Number.isFinite(data?.fps) && data.fps > 0) configuredFps = data.fps;
    }).catch(() => {
    });
  }
  function startHud() {
    let previousTime = performance.now(), previousDrawn = stats.drawn, previousBytes = stats.bytes, previousCpu, previousCpuTime = 0, metrics = METRICS_UNAVAILABLE;
    hudTimer = setInterval(() => {
      const now = performance.now(), seconds = (now - previousTime) / 1e3;
      const fps = (stats.drawn - previousDrawn) / seconds;
      const mbps = (stats.bytes - previousBytes) * 8 / seconds / 1e6;
      document.querySelector("#hud").textContent = hudText(fps, mbps, metrics);
      previousTime = now;
      previousDrawn = stats.drawn;
      previousBytes = stats.bytes;
      if (!metricsRequest && !document.querySelector("#stats").hidden) {
        const controller = metricsRequest = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2e3);
        fetch("/metrics", { cache: "no-store", signal: controller.signal, redirect: "error", headers: authHeaders() }).then((response) => {
          if (!response.ok) throw new Error("Metrics unavailable");
          return response.json();
        }).then((data) => {
          const time = performance.now();
          if (![data.usage_usec, data.memory_current, data.inactive_file].every((n) => Number.isFinite(n) && n >= 0)) {
            throw new Error("Invalid metrics");
          }
          const cpu = previousCpu !== void 0 && data.usage_usec >= previousCpu && time > previousCpuTime ? `${((data.usage_usec - previousCpu) / ((time - previousCpuTime) * 1e3) * 100).toFixed(1)}%` : "unavailable";
          const ram = (Math.max(0, data.memory_current - data.inactive_file) / 1048576).toFixed(1);
          metrics = `Cgroup CPU (one core): ${cpu} \xB7 Cgroup RAM: ${ram} MiB`;
          previousCpu = data.usage_usec;
          previousCpuTime = time;
        }).catch(() => {
          metrics = METRICS_UNAVAILABLE;
          previousCpu = void 0;
        }).finally(() => {
          clearTimeout(timer);
          if (metricsRequest === controller) metricsRequest = null;
        });
      }
    }, 1e3);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(hudTimer);
      metricsRequest?.abort();
      metricsRequest = null;
      document.querySelector("#hud").textContent = hudText(0, 0, METRICS_UNAVAILABLE);
      release();
      epoch++;
      retireDecoded();
      if (socket) socket.close();
      reset();
      clearTimeout(retryTimer);
      setStatus("Paused while hidden");
    } else {
      startHud();
      retry = 0;
      connect();
    }
  });
  function checkAccess(current) {
    fetch("/capabilities", { cache: "no-store", redirect: "error", headers: authHeaders() }).then((response) => {
      if (response.status !== 401 || current !== epoch) return;
      clearTimeout(retryTimer);
      setStatus(accessToken ? "Access token rejected" : "Access token required");
      setExpanded(true);
      showPanel("connection", true);
      document.querySelector("#access-token").focus();
    }).catch(() => {
    });
  }
  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }
  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
    }
  }
  var scaleButtons = {
    fit: document.querySelector('[data-scale="fit"]'),
    actual: document.querySelector('[data-scale="actual"]'),
    sharp: document.querySelector('[data-scale="sharp"]')
  };
  var scaleMode = stored("relay.scale") === "actual" ? "actual" : "fit";
  var sharpPixels = stored("relay.sharp") === "1";
  var dprQuery;
  function syncSize() {
    if (scaleMode !== "actual") {
      canvas.style.width = canvas.style.height = "";
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    canvas.style.width = `${canvas.width / ratio}px`;
    canvas.style.height = `${canvas.height / ratio}px`;
  }
  function applyScale() {
    document.body.classList.toggle("actual", scaleMode === "actual");
    canvas.style.imageRendering = sharpPixels ? "pixelated" : "";
    scaleButtons.fit.setAttribute("aria-pressed", String(scaleMode === "fit"));
    scaleButtons.actual.setAttribute("aria-pressed", String(scaleMode === "actual"));
    scaleButtons.sharp.setAttribute("aria-pressed", String(sharpPixels));
    syncSize();
    renderCursor();
  }
  function setScale(mode) {
    scaleMode = mode === "actual" ? "actual" : "fit";
    store("relay.scale", scaleMode);
    applyScale();
  }
  function toggleSharp() {
    sharpPixels = !sharpPixels;
    store("relay.sharp", sharpPixels ? "1" : "0");
    applyScale();
  }
  function watchDpr() {
    syncSize();
    dprQuery?.removeEventListener?.("change", watchDpr);
    dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery?.addEventListener?.("change", watchDpr);
  }
  window.addEventListener("resize", watchDpr);
  var metaButton = document.querySelector("#meta-ctrl");
  function applyMeta() {
    metaButton.setAttribute("aria-pressed", String(metaAsCtrl));
  }
  function toggleMeta() {
    release();
    metaAsCtrl = !metaAsCtrl;
    store("relay.metaCtrl", metaAsCtrl ? "1" : "0");
    applyMeta();
  }
  var toolbar = document.querySelector("#toolbar");
  var toggle = document.querySelector("#toolbar-toggle");
  var actions = document.querySelector("#toolbar-actions");
  var dot = document.querySelector("#dot");
  var panels = { keys: document.querySelector("#keys-panel"), connection: document.querySelector("#connection-panel") };
  panels.scale = document.querySelector("#scale-panel");
  function showPanel(name, open = panels[name]?.hidden) {
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = !(key === name && open);
      toolbar.querySelector(`[data-action="${key}"]`).setAttribute("aria-expanded", String(!panel.hidden));
    }
  }
  function setExpanded(open) {
    actions.hidden = !open;
    toolbar.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (!open) showPanel(null);
  }
  function applyControl() {
    const button = actions.querySelector('[data-action="control"]');
    const label = viewOnly ? "Take control" : "Release control";
    button.setAttribute("aria-pressed", String(!viewOnly));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }
  function setViewOnly(next) {
    if (viewOnly === next) return;
    release();
    viewOnly = next;
    applyControl();
    connect();
  }
  function syncStatus() {
    const text = status.textContent ?? "";
    dot.className = "dot" + (text.startsWith("Live") ? " live" : /^(Connecting|Waiting|Paused)/.test(text) ? "" : " error");
    toggle.setAttribute("title", text);
    toggle.setAttribute("aria-label", `Viewer controls: ${text}`);
  }
  new MutationObserver(syncStatus).observe(status, { childList: true, characterData: true, subtree: true });
  syncStatus();
  toggle.addEventListener("click", () => setExpanded(actions.hidden));
  canvas.addEventListener("pointerdown", () => showPanel(null));
  var toolbarActions = {
    fullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {
    }),
    scale: () => showPanel("scale"),
    keys: () => showPanel("keys"),
    connection: () => showPanel("connection"),
    screenshot: () => canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `desktop-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1e3);
    }, "image/png"),
    control: () => setViewOnly(!viewOnly),
    stats: (button) => {
      const panel = document.querySelector("#stats");
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-pressed", String(!panel.hidden));
    }
  };
  actions.addEventListener("click", (e) => {
    const button = e.target.closest("[data-action]");
    if (button) toolbarActions[button.dataset.action](button);
  });
  document.addEventListener("fullscreenchange", () => {
    toolbar.querySelector('[data-action="fullscreen"]').setAttribute("aria-pressed", String(Boolean(document.fullscreenElement)));
  });
  panels.scale.addEventListener("click", (e) => {
    const button = e.target.closest("[data-scale]");
    if (!button) return;
    if (button.dataset.scale === "sharp") toggleSharp();
    else setScale(button.dataset.scale);
  });
  function keepCanvasFocus(e) {
    if (e.target.closest("[data-hold]") || e.target.closest("[data-keys]") || e.target.closest("#meta-ctrl")) e.preventDefault();
  }
  panels.keys.addEventListener("pointerdown", keepCanvasFocus);
  panels.keys.addEventListener("mousedown", keepCanvasFocus);
  panels.keys.addEventListener("click", (e) => {
    if (e.target.closest("#meta-ctrl")) {
      toggleMeta();
      canvas.focus();
      return;
    }
    const hold = e.target.closest("[data-hold]");
    if (hold) {
      const code = keys[hold.dataset.hold];
      if (!dropLatch(code) && holdKey(code)) {
        latched.set(code, hold);
        hold.setAttribute("aria-pressed", "true");
      }
      canvas.focus();
      return;
    }
    const button = e.target.closest("[data-keys]");
    if (!button) return;
    const codes = button.dataset.keys.split("+").map((name) => keys[name]);
    const pressed = [];
    for (const code of codes) if (!latched.has(code) && holdKey(code)) pressed.push(code);
    for (const code of pressed.reverse()) releaseKey(code);
    if (codes.some((code) => code < 224)) releaseLatched();
    showPanel(null);
    canvas.focus();
  });
  panels.connection.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = document.querySelector("#access-token").value.trim();
    if (value && (!validToken(value) || !trustedPage)) {
      setStatus("Use a 64-character token over HTTPS or a localhost tunnel");
      return;
    }
    accessToken = value;
    retry = 0;
    connect();
  });
  if (!document.hidden) startHud();
  applyScale();
  applyMeta();
  applyControl();
  watchDpr();
  connect();
  return __toCommonJS(main_exports);
})();
