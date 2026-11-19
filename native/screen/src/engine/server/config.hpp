#pragma once

#include <libwebsockets.h>
#include <chrono>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace relay {
struct Config {
  std::string bind = "127.0.0.1", viewer, token, origin, authority, cert, key, backend, output;
  unsigned port = 8080;
  unsigned fps = 60;
  uint64_t bitrate_min = 1000000, bitrate_start = 8000000, bitrate_max = 40000000;
  bool proxy = false, insecure_local = false, check = false;
};
bool unsignedNumber(const std::string& text, uint64_t& value);
/** Fills config from argv and throws std::runtime_error on invalid options; returns false after printing --help. */
bool parseConfig(int argc, char** argv, Config& config);
bool secretEqual(const std::string& a, const std::string& b);
std::string header(lws* wsi, lws_token_indexes token);
bool authenticated(const Config& config, lws* wsi, bool websocket = false);
/**
 * One-time viewer tickets. A client with the token asks for one and hands it to
 * a viewer, which opens one WebSocket with it. A ticket works once, and only
 * until it expires, so a leaked viewer link stops working after its first use.
 */
class Tickets {
 public:
  using Clock = std::chrono::steady_clock;
  static constexpr size_t capacity = 16;
  static constexpr std::chrono::seconds lifetime{60};
  /** Keeps a ticket; the oldest goes when capacity are already waiting. */
  void add(const std::string& ticket, Clock::time_point now);
  /** Uses up a ticket; false when it is unknown, used, or expired. */
  bool redeem(const std::string& ticket, Clock::time_point now);
 private:
  std::vector<std::pair<std::string, Clock::time_point>> waiting;
  void expire(Clock::time_point now);
};
/**
 * Fills out with bytes from the OS CSPRNG. lws_get_random isn't safe for
 * secrets: libwebsockets before 5.1 uses unseeded rand() on Windows.
 */
bool secureRandom(unsigned char* out, size_t size);
/** The ticket a WebSocket offers as its ticket.TICKET subprotocol, or "". */
std::string offeredTicket(lws* wsi);
bool loopbackOrigin(const std::string& origin);
bool loopbackHost(const std::string& host);
bool localRequest(const Config& config, lws* wsi);
}  // namespace relay
