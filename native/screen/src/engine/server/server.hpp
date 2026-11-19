#pragma once

#include "config.hpp"
#include "core/capture.hpp"
#include "core/flow.hpp"
#include "core/input.hpp"
#include "screenshot.hpp"
#include "wire.hpp"
#include <libwebsockets.h>
#include <atomic>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace relay {
struct HttpResponse {
  unsigned char body[2048], input[max_input_batch * 16];
  size_t length, input_length, input_expected;
  std::vector<uint8_t>* image;
  size_t offset;
  bool image_headers, screenshot_error, control, view_only, input_reply, input_headers, closing;
  unsigned reply_status;
};
/** One viewer session at a time; the capture thread and the lws service thread share it through mutex. */
struct Server {
  struct InputReply {
    lws* wsi = nullptr;
    unsigned status = 0;
    std::string body;
    std::atomic<bool> ready{false};
  };
  struct ControlReply {
    uint32_t seq = 0;
    InputStatus status = InputStatus::ok;
    std::atomic<bool> ready{false};
  };
  /// Context the input thread may wake; it is set and cleared under this mutex so a fence never wakes a destroyed context.
  struct InputWake {
    void set(lws_context* next);
    void cancel();
    std::mutex mutex;
    lws_context* context = nullptr;
  };
  Config config;
  Tickets tickets;
  lws_context* context = nullptr;
  lws* viewer = nullptr;
  Screenshot screenshot;
  lws* screenshot_client = nullptr;
  bool controller = false, viewOnly = false, control_ready = false;
  std::deque<std::shared_ptr<ControlReply>> replies;
  std::mutex reply_mutex;
  std::deque<std::shared_ptr<InputReply>> input_replies;
  std::mutex mutex;
  std::shared_ptr<InputWake> wake = std::make_shared<InputWake>();
  std::unique_ptr<InputController> input;
  std::deque<EncodedFrame> pending;
  std::optional<CursorImage> pending_cursor;
  bool last_write_cursor = false;
  size_t buffered_stream_bytes = 0;
  uint32_t stream_notsent_lowat = 0;
  uint64_t flow_timer_due_us = 0;
  FlowControl flow;
  CaptureEncoder capture;
  uint32_t generation = 0, lastSequence = 0, nextGeneration = 0;
  uint16_t width = 0, height = 0;
  bool failed = false;
  std::vector<uint8_t> received;
  explicit Server(Config settings);
  void release();
  void end();
  bool holdsInput() const { return viewer && !viewOnly; }
  bool message();
  void updateFlow();
  bool timedOut();
  std::string metrics();
  /// Holds the HTTP response until the backend applied or dropped the batch; posted counts records that reached it.
  int deferInput(lws* wsi, InputStatus status, size_t applied, size_t posted);
  std::vector<std::shared_ptr<InputReply>> readyInputs();
  void forgetInput(lws* wsi);
  int writeControl(lws* wsi);
  int write(lws* wsi);
};
int callback(lws* wsi, lws_callback_reasons reason, void* user, void* in, size_t len);
}  // namespace relay
