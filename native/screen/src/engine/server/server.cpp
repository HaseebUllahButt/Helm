#include "server.hpp"
#include "backend.hpp"
#include "core/capture-source.hpp"
#include "metrics.hpp"
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <limits>
#ifdef __linux__
#include <sys/socket.h>
#include <netinet/in.h>
#include <linux/tcp.h>
#endif

namespace relay {
namespace {
using Clock = std::chrono::steady_clock;
uint64_t nowUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count();
}
/// Wakes the service thread once one deferred reply can be written.
class ReplyFence final : public InputFence {
 public:
  ReplyFence(std::shared_ptr<Server::InputWake> wake, std::function<void(bool, size_t)> mark)
      : wake(std::move(wake)), mark(std::move(mark)) {}
  void complete(bool applied, size_t dropped) override {
    mark(applied, dropped);
    wake->cancel();
  }
 private:
  std::shared_ptr<Server::InputWake> wake;
  std::function<void(bool, size_t)> mark;
};
#ifdef __linux__
void configureStreamSocket(lws* wsi) {
  const int fd = lws_get_socket_fd(wsi);
  if (fd < 0) return;
  const int enabled = 1;
  (void)setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
}
std::optional<FlowControl::TransportSample> streamTransportSample(lws* wsi, size_t buffered_bytes) {
  const int fd = lws_get_socket_fd(wsi);
  if (fd < 0) return std::nullopt;
  tcp_info info{};
  socklen_t length = sizeof(info);
  if (getsockopt(fd, IPPROTO_TCP, TCP_INFO, &info, &length) ||
      length < offsetof(tcp_info, tcpi_delivery_rate) + sizeof(info.tcpi_delivery_rate) ||
      !info.tcpi_min_rtt || info.tcpi_min_rtt == std::numeric_limits<uint32_t>::max()) return std::nullopt;
  FlowControl::TransportSample sample;
  sample.min_rtt_us = info.tcpi_min_rtt;
  sample.rtt_us = info.tcpi_rtt;
  sample.delivery_rate_bps = std::min<uint64_t>(info.tcpi_delivery_rate, std::numeric_limits<uint64_t>::max() / 8) * 8;
  sample.notsent_bytes = info.tcpi_notsent_bytes;
  sample.snd_cwnd = info.tcpi_snd_cwnd;
  sample.total_retrans = info.tcpi_total_retrans;
  sample.app_limited = info.tcpi_delivery_rate_app_limited;
  sample.bytes_acked = info.tcpi_bytes_acked;
  sample.application_queued_bytes = buffered_bytes;
  return sample;
}
#endif
}  // namespace
Server::Server(Config settings) : config(std::move(settings)), capture([this](EncodedFrame&& frame) {
  std::lock_guard<std::mutex> lock(mutex);
  if (!context || !generation || frame.generation != generation) return false;
  if (!flow.enqueue(frame.sequence, frame.annex_b.size(), frame.pts_us, nowUs())) {
    failed = true; lws_cancel_service(context); return false;
  }
  pending.push_back(std::move(frame));
  lws_cancel_service(context);
  return true;
}, CaptureSettings{config.fps, config.bitrate_min, config.bitrate_start, config.bitrate_max}, backendFor(config.backend).capture,
[this](uint32_t gen, CursorImage&& cursor) {
  std::lock_guard<std::mutex> lock(mutex);
  if (!context || !generation || gen != generation) return;
  pending_cursor = std::move(cursor);
  lws_cancel_service(context);
}) { flow.configure(config.bitrate_min, config.bitrate_start, config.bitrate_max, config.fps); }
void Server::release() { if (input) input->releaseAll(); }
void Server::end() {
  if (holdsInput()) { release(); input->cancel(); }
  uint32_t old;
  { std::lock_guard<std::mutex> lock(mutex); old = generation; generation = 0; pending.clear(); pending_cursor.reset(); flow.reset(); failed = false; }
  last_write_cursor = false;
  buffered_stream_bytes = 0; stream_notsent_lowat = 0; flow_timer_due_us = 0;
  if (old) capture.endSession(old);
  lastSequence = 0; received.clear(); replies.clear(); control_ready = controller = viewOnly = false; viewer = nullptr;
}
bool Server::message() {
  const auto& b = received;
  if (b.size() < 20 || std::memcmp(b.data(), "NSL1", 4) || b[4] != 1 || u16(b.data()+6) || u32(b.data()+16) != b.size()-20) return false;
  const auto gen = u32(b.data()+8), seq = u32(b.data()+12);
  if (!gen) return false;
  if (controller) {
    if (b[5] != 3 || b.size() != 36 || !seq || gen != generation || replies.size() >= 32) return false;
    auto reply = std::make_shared<ControlReply>();
    reply->seq = seq; reply->status = input->apply(inputEvent(b.data()+20));
    replies.push_back(reply);
    input->fence(std::make_shared<ReplyFence>(wake, [reply](bool, size_t) { reply->ready.store(true, std::memory_order_release); }));
    lws_callback_on_writable(viewer); return true;
  }
  if (b[5] == 2) {
    if (b.size() != 20 && b.size() != 24) return false;
    const uint64_t wait = FlowControl::ackWaitUs(b.data()+20, b.size()-20);
    bool accepted = false;
    { std::lock_guard<std::mutex> lock(mutex);
      if (gen == generation && seq) accepted = flow.ack(seq, nowUs(), wait);
    }
    if (accepted) { capture.acknowledge(gen, seq); updateFlow(); }
    return true;
  }
  if (b[5] != 3 || b.size() != 36 || seq || gen != generation) return false;
  if (viewOnly) return true;
  return input->apply(inputEvent(b.data()+20)) != InputStatus::invalid;
}
void Server::updateFlow() {
  if (viewer && !lws_partial_buffered(viewer)) buffered_stream_bytes = 0;
#ifdef __linux__
  const auto sample = viewer && !controller && !config.proxy ? streamTransportSample(viewer, buffered_stream_bytes) : std::nullopt;
  uint32_t notsent_lowat;
#endif
  uint32_t gen; unsigned window; uint64_t bitrate, admit_until, service_deadline; bool paused, inflight;
  { std::lock_guard<std::mutex> lock(mutex);
    const auto now = nowUs();
#ifdef __linux__
    if (sample) flow.sampleTransport(*sample, now); else flow.clearTransport();
#endif
    flow.update(now);
    gen = generation; window = flow.window; bitrate = flow.frameBitrate(); paused = flow.paused(now);
    inflight = !flow.frames.empty();
    admit_until = inflight && flow.transport_available ? flow.frames.front().captured_us + flow.transportAgeLimitUs() : 0;
#ifdef __linux__
    notsent_lowat = flow.notsentLowat();
#endif
    service_deadline = flow.serviceDeadlineUs(now, flow_timer_due_us);
  }
#ifdef __linux__
  if (viewer && !controller && notsent_lowat != stream_notsent_lowat) {
    const int fd = lws_get_socket_fd(viewer);
    if (fd >= 0) (void)setsockopt(fd, IPPROTO_TCP, TCP_NOTSENT_LOWAT, &notsent_lowat, sizeof(notsent_lowat));
    stream_notsent_lowat = notsent_lowat;
  }
#endif
  if (viewer && !controller && service_deadline != flow_timer_due_us) {
    const uint64_t now = nowUs();
    lws_set_timer_usecs(viewer, service_deadline - std::min(service_deadline, now));
    flow_timer_due_us = service_deadline;
  }
  // Never hold the transport mutex while calling the capture API. Publication takes it later.
  capture.setFlowControl(gen, window, bitrate, paused, admit_until);
}
bool Server::timedOut() {
  std::lock_guard<std::mutex> lock(mutex);
  return failed || flow.timedOut(nowUs());
}
std::string Server::metrics() {
  std::lock_guard<std::mutex> lock(mutex);
  return ",\"inflight_frames\":" + std::to_string(flow.frames.size()) +
      ",\"inflight_bytes\":" + std::to_string(flow.bytes) +
      ",\"window_frames\":" + std::to_string(flow.window) +
      ",\"target_bitrate_bps\":" + std::to_string(flow.target_bitrate) +
      ",\"min_rtt_ms\":" + std::to_string(flow.transport.min_rtt_us / 1000.0) +
      ",\"delivery_rate_bps\":" + std::to_string(flow.delivery_rate_bps) +
      ",\"notsent_bytes\":" + std::to_string(flow.transport.notsent_bytes) +
      ",\"sender_queue_ms\":" + std::to_string(flow.senderQueueUs() / 1000.0) +
      ",\"retrans\":" + std::to_string(flow.transport.total_retrans) +
      ",\"ack_rtt_ms\":" + std::to_string(flow.ack_rtt_us / 1000.0) +
      ",\"oldest_frame_ms\":" + std::to_string(flow.oldestAge(nowUs()) / 1000.0) +
      ",\"frames_acked\":" + std::to_string(flow.acknowledged) +
      ",\"frames_encoded\":" + std::to_string(flow.encoded) +
      ",\"observed_busy_goodput_bps\":" + std::to_string(flow.goodput_bps) +
      ",\"max_inflight_frames\":" + std::to_string(flow.frameLimit()) +
      ",\"max_inflight_bytes\":" + std::to_string(FlowControl::max_bytes) +
      ",\"max_frame_bytes\":" + std::to_string(FlowControl::max_bytes) +
      ",\"admission_age_ms\":" + std::to_string(flow.admissionAgeUs() / 1000.0) +
      ",\"no_ack_timeout_ms\":" + std::to_string(FlowControl::timeout_us / 1000) +
      ",\"max_frame_age_ms\":" + std::to_string(FlowControl::timeout_us / 1000);
}
int Server::writeControl(lws* wsi) {
  if (!control_ready && (replies.empty() || !replies.front()->ready.load(std::memory_order_acquire))) return 0;
  std::vector<uint8_t> wire;
  if (control_ready) controlReady(wire, LWS_PRE, generation, width, height);
  else inputReply(wire, LWS_PRE, generation, replies.front()->seq, replies.front()->status);
  const size_t size = wire.size() - LWS_PRE;
  if (lws_write(wsi, wire.data() + LWS_PRE, size, LWS_WRITE_BINARY) != int(size)) return -1;
  if (control_ready) control_ready = false; else replies.pop_front();
  if (!replies.empty() && replies.front()->ready.load(std::memory_order_acquire)) lws_callback_on_writable(wsi);
  return 0;
}
void Server::InputWake::set(lws_context* next) {
  std::lock_guard<std::mutex> lock(mutex);
  context = next;
}
void Server::InputWake::cancel() {
  std::lock_guard<std::mutex> lock(mutex);
  if (context) lws_cancel_service(context);
}
int Server::deferInput(lws* wsi, InputStatus status, size_t applied, size_t posted) {
  auto reply = std::make_shared<InputReply>();
  reply->wsi = wsi;
  if (status == InputStatus::ok) {
    reply->status = HTTP_STATUS_OK;
    reply->body = "{\"applied\":" + std::to_string(applied) + "}";
  } else {
    const bool invalid = status == InputStatus::invalid;
    reply->status = invalid ? HTTP_STATUS_BAD_REQUEST : 422;
    reply->body = std::string("{\"error\":\"") + (invalid ? "invalid_input" : "unsupported_input") +
                  "\",\"index\":" + std::to_string(applied - 1) + "}";
  }
  { std::lock_guard<std::mutex> lock(reply_mutex); input_replies.push_back(reply); }
  input->fence(std::make_shared<ReplyFence>(wake, [reply, posted](bool complete, size_t dropped) {
    if (!complete) {
      reply->status = HTTP_STATUS_CONFLICT;
      reply->body = "{\"error\":\"busy\",\"applied\":" + std::to_string(posted - dropped) + "}";
    }
    reply->ready.store(true, std::memory_order_release);
  }));
  return 0;
}
std::vector<std::shared_ptr<Server::InputReply>> Server::readyInputs() {
  std::vector<std::shared_ptr<InputReply>> ready;
  std::lock_guard<std::mutex> lock(reply_mutex);
  for (auto reply = input_replies.begin(); reply != input_replies.end();) {
    if (!(*reply)->ready.load(std::memory_order_acquire)) { ++reply; continue; }
    ready.push_back(*reply); reply = input_replies.erase(reply);
  }
  return ready;
}
void Server::forgetInput(lws* wsi) {
  std::lock_guard<std::mutex> lock(reply_mutex);
  input_replies.erase(std::remove_if(input_replies.begin(), input_replies.end(),
      [wsi](const std::shared_ptr<InputReply>& reply) { return reply->wsi == wsi; }), input_replies.end());
}
int Server::write(lws* wsi) {
  updateFlow();
  std::optional<EncodedFrame> frame;
  std::optional<CursorImage> cursor;
  { std::lock_guard<std::mutex> lock(mutex);
    if (failed) return -1;
    // Start with video to establish the generation; then share writes fairly.
    if (lastSequence && pending_cursor && (!last_write_cursor || pending.empty())) {
      cursor = std::move(pending_cursor); pending_cursor.reset();
    } else {
      if (pending.empty()) return 0;
      frame.emplace(std::move(pending.front())); pending.pop_front();
    }
  }
  std::vector<uint8_t> wire;
  if (cursor) {
    if (!cursorMessage(wire, LWS_PRE, generation, *cursor)) return -1;
    const size_t size = wire.size() - LWS_PRE;
    if (lws_write(wsi, wire.data() + LWS_PRE, size, LWS_WRITE_BINARY) != int(size)) return -1;
    buffered_stream_bytes = lws_partial_buffered(wsi) ? size : 0;
    last_write_cursor = true;
    updateFlow();
    { std::lock_guard<std::mutex> lock(mutex);
      if (!pending.empty() || pending_cursor) lws_callback_on_writable(wsi);
    }
    return 0;
  }
  auto& f = *frame;
  if (f.generation != generation) return 0;
  if (!frameMessage(wire, LWS_PRE, generation, lastSequence, f, width, height)) return -1;
  const size_t size = wire.size() - LWS_PRE;
  if (lws_write(wsi, wire.data() + LWS_PRE, size, LWS_WRITE_BINARY) != int(size)) return -1;
  buffered_stream_bytes = lws_partial_buffered(wsi) ? size : 0;
  width = f.width; height = f.height; lastSequence = f.sequence;
  last_write_cursor = false;
  { std::lock_guard<std::mutex> lock(mutex); if (!flow.sent(f.sequence, nowUs())) return -1; }
  updateFlow();
  { std::lock_guard<std::mutex> lock(mutex); if (!pending.empty() || pending_cursor) lws_callback_on_writable(wsi); }
  return 0;
}
namespace {
int responseHeaders(lws* wsi, unsigned status, const char* mime, size_t length) {
  unsigned char buffer[LWS_PRE+512];
  unsigned char* start = buffer+LWS_PRE;
  unsigned char* next = start;
  unsigned char* end = buffer+sizeof(buffer);
  if (lws_add_http_common_headers(wsi, status, mime, length, &next, end) ||
      lws_add_http_header_by_name(wsi, reinterpret_cast<const unsigned char*>("cache-control:"),
                                  reinterpret_cast<const unsigned char*>("no-store"), 8, &next, end) ||
      lws_add_http_header_by_token(wsi, WSI_TOKEN_CONNECTION,
                                   reinterpret_cast<const unsigned char*>("close"), 5, &next, end) ||
      lws_finalize_http_header(wsi, &next, end) ||
      lws_write(wsi, start, size_t(next-start), LWS_WRITE_HTTP_HEADERS) != next-start) return -1;
  lws_callback_on_writable(wsi); return 0;
}
/// Closes the HTTP connection once its response is flushed, since libwebsockets 4.1 spins on an idle
/// keep-alive connection that the peer has half-closed.
int completeResponse(lws* wsi, HttpResponse* response) {
  if (!lws_partial_buffered(wsi)) return -1;
  if (response) response->closing = true;
  lws_callback_on_writable(wsi); return 0;
}
int jsonResponse(lws* wsi, HttpResponse* response, unsigned status, const std::string& json) {
  if (!response || json.size() > sizeof(response->body)) return -1;
  std::memcpy(response->body, json.data(), json.size()); response->length = json.size();
  return responseHeaders(wsi, status, "application/json", response->length);
}
int errorResponse(lws* wsi, HttpResponse* response, unsigned status, const char* error) {
  return jsonResponse(wsi, response, status, "{\"error\":\"" + std::string(error) + "\"}");
}
constexpr char fileCloseHeaders[] = "connection: close\r\n";
constexpr char viewerHtmlHeaders[] =
    "connection: close\r\n"
    "content-security-policy: frame-ancestors 'none'\r\n"
    "x-frame-options: DENY\r\n";
void closeScreenshot(Server* server, lws* wsi, HttpResponse* response) {
  if (server->screenshot_client == wsi) {
    server->screenshot_client = nullptr;
    lws_set_timer_usecs(wsi, LWS_SET_TIMER_USEC_CANCEL);
    // During capture the slot stays busy until its worker result is safely discarded.
    if (response && response->image) server->screenshot.finish();
  }
  if (response) { delete response->image; response->image = nullptr; response->offset = 0; }
}
int inputResponse(lws* wsi, HttpResponse* response, Server* s) {
  const bool complete = response->input_length == response->input_expected;
  response->input_expected = 0;
  if (!complete) return -1;
  if (s->holdsInput()) return errorResponse(wsi, response, HTTP_STATUS_CONFLICT, "busy");
  const size_t count = response->input_length / 16;
  if (s->input->pending() + count > max_queued_events) return errorResponse(wsi, response, HTTP_STATUS_CONFLICT, "busy");
  size_t index = 0;
  auto status = InputStatus::ok;
  for (; index < count && status == InputStatus::ok; ++index) status = s->input->apply(inputEvent(response->input + index * 16));
  s->release();
  return s->deferInput(wsi, status, index, status == InputStatus::ok ? index : index - 1);
}
int metricsResponse(lws* wsi, HttpResponse* response, Server* server) {
  if (!response) return -1;
  std::string json;
  const bool available = cgroupMetrics(json);
  if (!available) json = "{\"resources_available\":false,\"usage_usec\":null,\"memory_current\":null,\"inactive_file\":null}";
  json.pop_back(); json += server->metrics() + "}";
  if (json.size() > sizeof(response->body)) return -1;
  std::memcpy(response->body, json.data(), json.size());
  response->length = json.size();
  return responseHeaders(wsi, HTTP_STATUS_OK,
                         "application/json", response->length);
}
}  // namespace
int callback(lws* wsi, lws_callback_reasons reason, void* user, void* in, size_t len) {
  auto* s = static_cast<Server*>(lws_context_user(lws_get_context(wsi)));
  if (!s) return 0;
  switch (reason) {
    case LWS_CALLBACK_HTTP: {
      const std::string path(static_cast<const char*>(in), len);
      auto* response = static_cast<HttpResponse*>(user);
      if (response) { response->input_reply = false; response->input_headers = false; response->reply_status = 0; }
      if (path == "/input") {
        if (!response) return -1;
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (!authenticated(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        uint64_t length = 0;
        if (const auto status = inputLength(header(wsi, WSI_TOKEN_HTTP_CONTENT_LENGTH), length)) {
          return errorResponse(wsi, response, status, status == HTTP_STATUS_LENGTH_REQUIRED ? "length_required" :
                               status == HTTP_STATUS_REQ_ENTITY_TOO_LARGE ? "too_large" : "invalid_input");
        }
        if (s->holdsInput()) return errorResponse(wsi, response, HTTP_STATUS_CONFLICT, "busy");
        response->input_length = 0; response->input_expected = length; return 0;
      }
      if (path == "/tickets") {
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (!authenticated(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        unsigned char bytes[32];
        if (!secureRandom(bytes, sizeof(bytes))) return errorResponse(wsi, response, HTTP_STATUS_INTERNAL_SERVER_ERROR, "random_failed");
        static const char digits[] = "0123456789abcdef";
        std::string ticket;
        for (const unsigned char byte : bytes) { ticket += digits[byte >> 4]; ticket += digits[byte & 15]; }
        s->tickets.add(ticket, Tickets::Clock::now());
        return jsonResponse(wsi, response, HTTP_STATUS_OK, "{\"ticket\":\"" + ticket + "\",\"expires_in\":" +
                            std::to_string(Tickets::lifetime.count()) + "}");
      }
      if (path == "/metrics" || path == "/capabilities" || path == "/screenshot.png") {
        if (lws_hdr_total_length(wsi, WSI_TOKEN_GET_URI) <= 0) {
          return errorResponse(wsi, response, HTTP_STATUS_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!localRequest(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_FORBIDDEN, "forbidden");
        if (!authenticated(s->config, wsi)) return errorResponse(wsi, response, HTTP_STATUS_UNAUTHORIZED, "unauthorized");
        if (path == "/metrics") return metricsResponse(wsi, response, s);
        if (path == "/screenshot.png") {
          if (s->screenshot_client || !s->screenshot.request()) {
            return errorResponse(wsi, response, HTTP_STATUS_SERVICE_UNAVAILABLE, "busy");
          }
          s->screenshot_client = wsi; response->image_headers = false; response->offset = 0;
          lws_set_timer_usecs(wsi, 5000000); return 0;
        }
        const std::string backend = s->input->name();
        const std::string json = "{\"version\":1,\"backend\":\"" + backend +
            "\",\"width\":" + std::to_string(s->width) + ",\"height\":" + std::to_string(s->height) +
            ",\"fps\":" + std::to_string(s->config.fps) +
            ",\"input\":{\"keyboard\":true,\"pointer\":true,\"buttons\":true,\"wheel\":true}," +
            "\"screenshot\":\"/screenshot.png\",\"control\":\"/control\",\"wayland\":" +
            (backend == "wayland" ? "true" : "false") +
            ",\"max_input_pending\":32,\"cursor\":" + (s->capture.stats().cursor_supported ? "true" : "false") +
            ",\"input_endpoint\":\"/input\",\"tickets\":\"/tickets\",\"max_input_batch\":" + std::to_string(max_input_batch) +
            ",\"audio\":false,\"clipboard\":false,\"resize\":false,\"ime\":false}";
        return jsonResponse(wsi, response, HTTP_STATUS_OK, json);
      }
      std::string file; const char* mime = nullptr; const char* headers = nullptr; int headerCount = 0;
      if (path == "/" || path == "/index.html") {
        file=s->config.viewer+"/index.html"; mime="text/html";
        headers=viewerHtmlHeaders; headerCount=int(sizeof(viewerHtmlHeaders)-1);
      }
      if (path == "/viewer.js") {
        file=s->config.viewer+"/viewer.js"; mime="application/javascript";
        headers=fileCloseHeaders; headerCount=int(sizeof(fileCloseHeaders)-1);
      }
      if (file.empty()) return errorResponse(wsi, response, HTTP_STATUS_NOT_FOUND, "not_found");
      return lws_serve_http_file(wsi, file.c_str(), mime, headers, headerCount) < 0 ? -1 : 0;
    }
    case LWS_CALLBACK_HTTP_WRITEABLE: {
      auto* response = static_cast<HttpResponse*>(user);
      if (!response) return -1;
      if (response->closing) return completeResponse(wsi, response);
      if (response->input_reply) {
        if (!response->input_headers) {
          response->input_headers = true;
          return responseHeaders(wsi, response->reply_status, "application/json", response->length);
        }
        response->input_reply = false;
      }
      if (response->image) {
        if (!response->image_headers) {
          response->image_headers = true;
          return responseHeaders(wsi, response->screenshot_error ? HTTP_STATUS_SERVICE_UNAVAILABLE : HTTP_STATUS_OK,
                                 response->screenshot_error ? "application/json" : "image/png", response->image->size());
        }
        unsigned char chunk[LWS_PRE + 16384];
        const size_t count = std::min<size_t>(16384, response->image->size() - response->offset);
        const bool final = response->offset + count == response->image->size();
        std::memcpy(chunk+LWS_PRE, response->image->data()+response->offset, count);
        if (lws_write(wsi, chunk+LWS_PRE, count, final ? LWS_WRITE_HTTP_FINAL : LWS_WRITE_HTTP) != int(count)) return -1;
        response->offset += count;
        if (!final) { lws_callback_on_writable(wsi); return 0; }
        closeScreenshot(s, wsi, response); return completeResponse(wsi, response);
      }
      if (!response->length) return 0;
      unsigned char buffer[LWS_PRE+2048];
      std::memcpy(buffer+LWS_PRE, response->body, response->length);
      const size_t count = response->length;
      response->length = 0;
      if (lws_write(wsi, buffer+LWS_PRE, count, LWS_WRITE_HTTP_FINAL) != int(count)) return -1;
      return completeResponse(wsi, response);
    }
    case LWS_CALLBACK_HTTP_BODY: {
      auto* response = static_cast<HttpResponse*>(user);
      if (!response || !response->input_expected) return 0;
      if (len > response->input_expected - response->input_length) return -1;
      std::memcpy(response->input + response->input_length, in, len); response->input_length += len;
      return 0;
    }
    case LWS_CALLBACK_HTTP_BODY_COMPLETION: {
      auto* response = static_cast<HttpResponse*>(user);
      return response && response->input_expected ? inputResponse(wsi, response, s) : 0;
    }
    case LWS_CALLBACK_CLOSED_HTTP: closeScreenshot(s, wsi, static_cast<HttpResponse*>(user)); s->forgetInput(wsi); return 0;
    case LWS_CALLBACK_HTTP_FILE_COMPLETION: return completeResponse(wsi, static_cast<HttpResponse*>(user));
    case LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION: {
      char uri[256] = {}, args[256] = {};
      if (lws_hdr_copy(wsi, uri, sizeof(uri), WSI_TOKEN_GET_URI) <= 0 || !user) return 1;
      std::string target(uri);
      if (lws_hdr_copy(wsi, args, sizeof(args), WSI_TOKEN_HTTP_URI_ARGS) > 0) { target += '?'; target += args; }
      bool control = false, viewOnly = false;
      if (!viewerTarget(target, control, viewOnly)) return 1;
      if (!localRequest(s->config, wsi) || s->viewer || s->nextGeneration == UINT32_MAX) return 1;
      // Check a ticket only for a connection that would open, so a refused
      // one doesn't use it up.
      if (!authenticated(s->config, wsi, true) && !s->tickets.redeem(offeredTicket(wsi), Tickets::Clock::now())) return 1;
      auto* response = static_cast<HttpResponse*>(user);
      response->control = control; response->view_only = viewOnly;
      return 0;
    }
    case LWS_CALLBACK_ESTABLISHED: {
      if (s->viewer || s->nextGeneration == UINT32_MAX) return -1;
      auto* response = static_cast<HttpResponse*>(user);
      s->viewer = wsi; s->controller = response->control; s->viewOnly = response->view_only;
#ifdef __linux__
      if (!s->controller) configureStreamSocket(wsi);
#endif
      { std::lock_guard<std::mutex> lock(s->mutex); s->generation = ++s->nextGeneration; s->pending.clear(); s->pending_cursor.reset(); s->flow.reset(); s->failed=false; }
      s->last_write_cursor = false;
      s->lastSequence=0; s->received.clear();
      if (!s->viewOnly) s->input->resetLocks();
      if (s->controller) { s->control_ready = true; lws_callback_on_writable(wsi); }
      else { s->capture.beginSession(s->generation); s->updateFlow(); }
      return 0;
    }
    case LWS_CALLBACK_RECEIVE:
      if (s->viewer != wsi || !lws_frame_is_binary(wsi) || len > 65536-s->received.size()) return -1;
      s->received.insert(s->received.end(), static_cast<uint8_t*>(in), static_cast<uint8_t*>(in)+len);
      if (s->received.size() > 36) return -1;
      if (lws_is_final_fragment(wsi) && !lws_remaining_packet_payload(wsi)) {
        if (!s->message()) return -1;
        s->received.clear();
      }
      return 0;
    case LWS_CALLBACK_SERVER_WRITEABLE: return s->viewer == wsi ? (s->controller ? s->writeControl(wsi) : s->write(wsi)) : -1;
    case LWS_CALLBACK_EVENT_WAIT_CANCELLED: {
      if (s->viewer) {
        if (!s->controller) s->updateFlow();
        lws_callback_on_writable(s->viewer);
      }
      for (const auto& reply : s->readyInputs()) {
        auto* response = reply->wsi ? static_cast<HttpResponse*>(lws_wsi_user(reply->wsi)) : nullptr;
        if (!response) continue;
        std::memcpy(response->body, reply->body.data(), reply->body.size());
        response->length = reply->body.size();
        response->reply_status = reply->status;
        response->input_reply = true; response->input_headers = false;
        lws_callback_on_writable(reply->wsi);
      }
      std::vector<uint8_t> image; std::string error;
      if (s->screenshot.take(image, error)) {
        if (!s->screenshot_client) { s->screenshot.finish(); return 0; }
        auto* response = static_cast<HttpResponse*>(lws_wsi_user(s->screenshot_client));
        if (!response) { s->screenshot_client = nullptr; s->screenshot.finish(); return 0; }
        response->screenshot_error = !error.empty();
        if (!error.empty()) {
          std::cerr << "Screenshot failed: " << error << '\n';
          const std::string body = "{\"error\":\"screenshot_unavailable\"}";
          image.assign(body.begin(), body.end());
        }
        response->image = new std::vector<uint8_t>(std::move(image));
        lws_callback_on_writable(s->screenshot_client);
      }
      return 0;
    }
    case LWS_CALLBACK_TIMER:
      if (s->screenshot_client == wsi) { closeScreenshot(s, wsi, static_cast<HttpResponse*>(user)); return -1; }
      if (s->viewer != wsi) return -1;
      s->flow_timer_due_us = 0;
      if (s->timedOut()) {
        std::cerr << "Viewer flow failure, 3s frame age, or no ACK progress for 3s\n"; s->end(); return -1;
      }
      s->updateFlow();
      return 0;
    case LWS_CALLBACK_CLOSED: if (s->viewer == wsi) s->end(); return 0;
    default: return 0;
  }
}
}  // namespace relay
