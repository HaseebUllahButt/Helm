#include "server.hpp"
#include "backend.hpp"
#include <csignal>
#include <iostream>
#include <unistd.h>
#if defined(__GLIBC__)
#include <malloc.h>
#endif

namespace {
volatile std::sig_atomic_t stopping = 0;
void signalStop(int) { stopping = 1; }
lws_sorted_usec_list_t heartbeat{};
lws_context* heartbeatContext = nullptr;
void heartbeatTick(lws_sorted_usec_list_t*) {
  lws_sul_schedule(heartbeatContext, 0, &heartbeat, heartbeatTick, 100000);
}
}  // namespace
int main(int argc, char** argv) {
#if defined(__GLIBC__)
  mallopt(M_ARENA_MAX, 2);
#endif
  relay::Config config;
  try {
    if (!relay::parseConfig(argc, argv, config)) return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 2; }
  const auto& backend = relay::backendFor(config.backend);
  if (!backend.initialize(config.output)) { std::cerr << "Native backend initialization failed\n"; return 1; }
  if (config.check) return 0;
  std::signal(SIGINT, signalStop); std::signal(SIGTERM, signalStop);
  relay::Server s(config);
  std::string captureError;
  if (!s.capture.start(captureError)) {
    std::cerr << "Capture startup failed: " << captureError << '\n';
    s.capture.stop(); return 1;
  }
  try {
    s.input = std::make_unique<relay::InputController>(backend.input());
    const auto dimensions = s.input->dimensions();
    relay::requireSurfaceSize(dimensions.first, dimensions.second);
    s.width = dimensions.first; s.height = dimensions.second;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; s.capture.stop(); return 1; }
  lws_protocols protocols[] = {{"http", relay::callback, sizeof(relay::HttpResponse), 4096, 0, nullptr, 0}, {"nsl1", relay::callback, sizeof(relay::HttpResponse), 4096, 0, nullptr, 0}, {nullptr, nullptr, 0, 0, 0, nullptr, 0}};
  lws_context_creation_info info{};
  info.port=int(config.port); info.iface=config.bind.c_str(); info.protocols=protocols; info.user=&s;
  info.fd_limit_per_thread = 1024;
  // shortcut: native TLS supports HTTP/1.1 only, enable HTTP/2 after multiplexed-response lifecycle tests.
  info.alpn = "http/1.1";
  if (!config.cert.empty()) {
    info.options |= LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;
    info.ssl_cert_filepath = config.cert.c_str(); info.ssl_private_key_filepath = config.key.c_str();
  }
  info.uid=-1; info.gid=-1;
  s.context=lws_create_context(&info);
  if (!s.context) { std::cerr << "Cannot listen on " << config.bind << ':' << config.port << '\n'; s.capture.stop(); return 1; }
  s.wake->set(s.context);
  s.screenshot.start(s.context);
  heartbeatContext=s.context;
  lws_sul_schedule(s.context, 0, &heartbeat, heartbeatTick, 100000);
  int result = 0;
  std::cerr << "Relay listening on " << config.bind << ':' << config.port << '\n';
  std::cout << "{\"ready\":true,\"pid\":" << getpid() << ",\"port\":" << config.port << "}" << std::endl;
  while (!stopping) {
    captureError = s.capture.error();
    if (!captureError.empty()) {
      std::cerr << "Capture worker failed: " << captureError << '\n';
      result = 1; break;
    }
    if (lws_service(s.context, 100) < 0) {
      std::cerr << "WebSocket service failed\n";
      result = 1; break;
    }
  }
  s.end(); s.capture.stop(); s.screenshot.stop(); s.input.reset();
  const auto stats=s.capture.stats();
  std::cerr << "capture_stats captures=" << stats.captures << " encoded=" << stats.encoded
            << " capture_ns=" << stats.capture_ns << " convert_ns=" << stats.convert_ns << " encode_ns=" << stats.encode_ns << '\n';
  lws_sul_cancel(&heartbeat);
  s.wake->set(nullptr);
  lws_context_destroy(s.context); s.context=nullptr; heartbeatContext=nullptr;
  return result;
}
