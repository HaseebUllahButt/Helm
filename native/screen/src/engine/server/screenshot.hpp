#pragma once

#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct lws_context;

namespace relay {
// One job/result globally. The worker owns its capture source and PNG codec.
class Screenshot {
 public:
  ~Screenshot() { stop(); }
  void start(lws_context* context);
  bool request();
  bool take(std::vector<uint8_t>& bytes, std::string& error);
  void finish();
  void stop();
 private:
  std::mutex mutex_;
  std::condition_variable ready_;
  std::thread worker_;
  bool busy_ = false, requested_ = false, complete_ = false, stopping_ = false;
  std::vector<uint8_t> bytes_;
  std::string error_;
  void run(lws_context* context);
};
}  // namespace relay
