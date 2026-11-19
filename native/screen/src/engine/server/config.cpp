#include "config.hpp"
#include "backend.hpp"
#include <algorithm>
#include <charconv>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#else
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <cerrno>
#include <mach-o/dyld.h>
#include <membership.h>
#include <sys/acl.h>
#include <uuid/uuid.h>
#endif

namespace relay {
namespace {
#ifdef _WIN32
/// Reports whether an ACE only denies, audits, or labels access, so it cannot grant anyone access to the file.
bool deniesOrAudits(BYTE type) {
  switch (type) {
    case ACCESS_DENIED_ACE_TYPE: case ACCESS_DENIED_OBJECT_ACE_TYPE: case ACCESS_DENIED_CALLBACK_ACE_TYPE:
    case ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: case SYSTEM_AUDIT_ACE_TYPE: case SYSTEM_AUDIT_OBJECT_ACE_TYPE:
    case SYSTEM_AUDIT_CALLBACK_ACE_TYPE: case SYSTEM_AUDIT_CALLBACK_OBJECT_ACE_TYPE: case SYSTEM_ALARM_ACE_TYPE:
    case SYSTEM_MANDATORY_LABEL_ACE_TYPE:
      return true;
    default:
      return false;
  }
}
/// Reports whether only the current user, SYSTEM, and Administrators own or may open the file.
bool privateTokenFile(const std::string& path) {
  std::error_code error;
  if (!std::filesystem::is_regular_file(path, error) || std::filesystem::file_size(path, error) > 66 || error) return false;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  alignas(TOKEN_USER) unsigned char buffer[256];
  DWORD length = 0;
  const bool queried = GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &length);
  CloseHandle(token);
  if (!queried) return false;
  const PSID user = reinterpret_cast<TOKEN_USER*>(buffer)->User.Sid;
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetNamedSecurityInfoA(path.c_str(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                            &owner, nullptr, &dacl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  const auto privileged = [&](PSID sid) {
    return EqualSid(sid, user) || IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
  };
  bool owned = dacl && owner && privileged(owner);
  for (DWORD index = 0; owned && index < dacl->AceCount; ++index) {
    ACE_HEADER* header = nullptr;
    if (!GetAce(dacl, index, reinterpret_cast<void**>(&header))) { owned = false; break; }
    if (deniesOrAudits(header->AceType)) continue;
    owned = header->AceType == ACCESS_ALLOWED_ACE_TYPE &&
            privileged(&reinterpret_cast<ACCESS_ALLOWED_ACE*>(header)->SidStart);
  }
  LocalFree(descriptor);
  return owned;
}
/// Path of the running engine binary, used to find the bundled viewer.
std::filesystem::path executablePath() {
  wchar_t path[MAX_PATH];
  const DWORD length = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (!length || length == MAX_PATH) throw std::runtime_error("Could not find the engine executable");
  return std::filesystem::path(path);
}
#elif defined(__APPLE__)
/// Path of the running engine binary, used to find the bundled viewer.
std::filesystem::path executablePath() {
  uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || !size) throw std::runtime_error("Could not find the engine executable");
  std::string path(size, '\0');
  if (_NSGetExecutablePath(path.data(), &size) != 0) throw std::runtime_error("Could not find the engine executable");
  return std::filesystem::canonical(path.c_str());
}
#else
/// Path of the running engine binary, used to find the bundled viewer.
std::filesystem::path executablePath() { return std::filesystem::canonical("/proc/self/exe"); }
#endif
#ifdef __APPLE__
/// Reports whether an extended ACL entry names only the user running the engine.
bool ownerAclEntry(acl_entry_t entry) {
  uuid_t owner;
  if (mbr_uid_to_uuid(geteuid(), owner)) return false;
  void* qualifier = acl_get_qualifier(entry);
  if (!qualifier) return false;
  const bool same = uuid_compare(*static_cast<uuid_t*>(qualifier), owner) == 0;
  acl_free(qualifier);
  return same;
}
/// Reports whether the file has no extended ACL entry that could grant another user access; deny entries and
/// allow entries for the owner are still accepted.
bool privateTokenAcl(const std::string& path) {
  acl_t acl = acl_get_file(path.c_str(), ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  while (result == 0) {
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag)) break;
    if (tag != ACL_EXTENDED_DENY && (tag != ACL_EXTENDED_ALLOW || !ownerAclEntry(entry))) break;
    result = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  const bool safe = result == -1 && errno == EINVAL;
  acl_free(acl);
  return safe;
}
#elif !defined(_WIN32)
/// Mode bits already reflect POSIX ACL grants, so there is nothing extra to check.
bool privateTokenAcl(const std::string&) { return true; }
#endif
#ifndef _WIN32
/// Reports whether the current user owns the file and no other user can read or write it.
bool privateTokenFile(const std::string& path) {
  struct stat st{};
  return !stat(path.c_str(), &st) && S_ISREG(st.st_mode) && st.st_uid == geteuid() && !(st.st_mode & 0077) &&
         st.st_size <= 66 && privateTokenAcl(path);
}
#endif
}
bool secretEqual(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned difference = 0;
  for (size_t i = 0; i < a.size(); ++i) difference |= unsigned(a[i] ^ b[i]);
  return difference == 0;
}
std::string header(lws* wsi, lws_token_indexes token) {
  char value[1024];
  const int count = lws_hdr_copy(wsi, value, sizeof(value), token);
  return count > 0 ? std::string(value, size_t(count)) : "";
}
bool authenticated(const Config& config, lws* wsi, bool websocket) {
  if (config.token.empty()) return true;
  if (!websocket) return secretEqual(header(wsi, WSI_TOKEN_HTTP_AUTHORIZATION), "Bearer " + config.token);
  std::istringstream protocols(header(wsi, WSI_TOKEN_PROTOCOL));
  std::string protocol;
  while (std::getline(protocols, protocol, ',')) {
    const auto first = protocol.find_first_not_of(" \t");
    const auto last = protocol.find_last_not_of(" \t");
    if (first != std::string::npos && secretEqual(protocol.substr(first, last-first+1), "bearer." + config.token)) return true;
  }
  return false;
}
bool secureRandom(unsigned char* out, size_t size) {
#ifdef _WIN32
  return BCRYPT_SUCCESS(BCryptGenRandom(nullptr, out, ULONG(size), BCRYPT_USE_SYSTEM_PREFERRED_RNG));
#else
  // getentropy fills at most 256 bytes per call.
  for (size_t done = 0; done < size; done += 256) {
    if (getentropy(out + done, std::min<size_t>(256, size - done)) != 0) return false;
  }
  return true;
#endif
}
void Tickets::expire(Clock::time_point now) {
  waiting.erase(std::remove_if(waiting.begin(), waiting.end(),
                               [now](const auto& entry) { return now >= entry.second; }),
                waiting.end());
}
void Tickets::add(const std::string& ticket, Clock::time_point now) {
  expire(now);
  if (waiting.size() >= capacity) waiting.erase(waiting.begin());
  waiting.emplace_back(ticket, now + lifetime);
}
bool Tickets::redeem(const std::string& ticket, Clock::time_point now) {
  expire(now);
  if (ticket.empty()) return false;
  for (auto entry = waiting.begin(); entry != waiting.end(); ++entry) {
    if (secretEqual(entry->first, ticket)) { waiting.erase(entry); return true; }
  }
  return false;
}
std::string offeredTicket(lws* wsi) {
  std::istringstream protocols(header(wsi, WSI_TOKEN_PROTOCOL));
  std::string protocol;
  while (std::getline(protocols, protocol, ',')) {
    const auto first = protocol.find_first_not_of(" \t");
    const auto last = protocol.find_last_not_of(" \t");
    if (first == std::string::npos) continue;
    protocol = protocol.substr(first, last-first+1);
    if (protocol.rfind("ticket.", 0) == 0) return protocol.substr(7);
  }
  return "";
}
bool loopbackOrigin(const std::string& origin) {
  const auto scheme = origin.find("://");
  if (scheme == std::string::npos || (origin.substr(0, scheme) != "http" && origin.substr(0, scheme) != "https")) return false;
  const auto host = origin.substr(scheme + 3);
  auto colon = host.find(':');
  const auto name = host.substr(0, colon);
  if (name != "localhost" && name != "127.0.0.1") return false;
  if (colon == std::string::npos) return true;
  const auto port = host.substr(colon + 1);
  if (port.empty() || port.size() > 5) return false;
  unsigned value = 0;
  for (char c : port) { if (c < '0' || c > '9') return false; value = value * 10 + unsigned(c - '0'); }
  return value > 0 && value <= 65535;
}
bool loopbackHost(const std::string& host) { return loopbackOrigin("http://" + host); }
bool localRequest(const Config& config, lws* wsi) {
  const auto host = header(wsi, WSI_TOKEN_HOST);
  if (!loopbackHost(host) && (config.origin.empty() || host != config.authority)) return false;
  if (!config.token.empty() || lws_hdr_total_length(wsi, WSI_TOKEN_ORIGIN) <= 0) return true;
  return loopbackHost(host) && loopbackOrigin(header(wsi, WSI_TOKEN_ORIGIN));
}
bool unsignedNumber(const std::string& text, uint64_t& value) {
  if (text.empty()) return false;
  const auto parsed = std::from_chars(text.data(), text.data()+text.size(), value);
  return parsed.ec == std::errc{} && parsed.ptr == text.data()+text.size();
}
bool parseConfig(int argc, char** argv, Config& config) {
  config.viewer = (executablePath().parent_path() / "viewer").string();
  if (config.backend.empty()) config.backend = defaultBackend().name;
  const auto bitrate = [](const std::string& text) {
    uint64_t value;
    if (!unsignedNumber(text, value) || value < 250000 || value > 100000000)
      throw std::runtime_error("Bitrate must be an integer from 250000 to 100000000 bits per second");
    return value;
  };
  for (int i = 1; i < argc; ++i) {
    const std::string option = argv[i];
    if (option == "--help") {
      std::cout << "Usage: relay-engine [--bind ADDRESS] [--port PORT] [--viewer-dir DIR]\n"
                   "  [--backend NAME] [--output NAME] [--check]\n"
                   "  [--fps N] [--bitrate-min BPS] [--bitrate-start BPS] [--bitrate-max BPS]\n"
                   "  [--token-file FILE [--public-origin https://HOST[:PORT]]]\n"
                   "  [--tls-cert FILE --tls-key FILE | --behind-tls-proxy]\n"
                   "  [--insecure-local: unauthenticated, isolated development network only]\n"
                   "FPS is 10 to 120; bitrates are 250000 to 100000000 bits per second with\n"
                   "min <= start <= max. Non-loopback --bind needs --token-file;\n"
                   "--public-origin also needs TLS or --behind-tls-proxy.\n"
                   "--check initializes the backend and exits without starting capture or the server.\n"
                   "Attach to DISPLAY using the caller's XAUTHORITY. Defaults: 127.0.0.1:8080, 60 fps,\n"
                   "1000000/8000000/40000000 bps.\n"
                << "Compiled backends: " << backendNames() << '\n';
      return false;
    }
    if (option == "--behind-tls-proxy") { config.proxy = true; continue; }
    if (option == "--insecure-local") { config.insecure_local = true; continue; }
    if (option == "--check") { config.check = true; continue; }
    if (++i == argc) throw std::runtime_error("Missing value for " + option);
    const std::string value = argv[i];
    if (option == "--bind") config.bind = value;
    else if (option == "--backend") config.backend = value;
    else if (option == "--output") config.output = value;
    else if (option == "--port") {
      uint64_t port;
      if (!unsignedNumber(value, port) || !port || port > 65535) throw std::runtime_error("Invalid port");
      config.port = unsigned(port);
    } else if (option == "--fps") {
      uint64_t fps;
      if (!unsignedNumber(value, fps) || fps < 10 || fps > 120)
        throw std::runtime_error("FPS must be an integer from 10 to 120");
      config.fps = unsigned(fps);
    } else if (option == "--bitrate-min") config.bitrate_min = bitrate(value);
    else if (option == "--bitrate-start") config.bitrate_start = bitrate(value);
    else if (option == "--bitrate-max") config.bitrate_max = bitrate(value);
    else if (option == "--viewer-dir") config.viewer = value;
    else if (option == "--public-origin") {
      if (value.rfind("https://", 0) != 0 || value.size() <= 8 || value.find_first_of("/?#@\\ \t\r\n", 8) != std::string::npos)
        throw std::runtime_error("Public origin must be an HTTPS origin without path or credentials");
      config.origin = value; config.authority = value.substr(8);
    } else if (option == "--token-file") {
      if (!privateTokenFile(value))
        throw std::runtime_error("Token file must be private, owned by this user and contain 64 hexadecimal characters");
      std::ifstream file(value); std::getline(file, config.token);
      if (!file || config.token.size() != 64 || config.token.find_first_not_of("0123456789abcdef") != std::string::npos)
        throw std::runtime_error("Token must contain 64 lowercase hexadecimal characters");
    } else if (option == "--tls-cert") config.cert = value;
    else if (option == "--tls-key") config.key = value;
    else throw std::runtime_error("Unknown option: " + option);
  }
  backendFor(config.backend);
  if (config.cert.empty() != config.key.empty() || (config.proxy && !config.cert.empty()))
    throw std::runtime_error("Choose a TLS certificate/key pair or a TLS proxy");
  if (config.bitrate_min > config.bitrate_start || config.bitrate_start > config.bitrate_max)
    throw std::runtime_error("Bitrates must satisfy min <= start <= max");
  if (!config.origin.empty() && config.token.empty()) throw std::runtime_error("Public origin requires a token");
  if (config.insecure_local && (!config.token.empty() || !config.origin.empty() || !config.cert.empty() || config.proxy))
    throw std::runtime_error("--insecure-local cannot be combined with remote access options");
  if (config.bind != "127.0.0.1" && !config.insecure_local && (config.token.empty() || (!config.origin.empty() && config.cert.empty() && !config.proxy)))
    throw std::runtime_error("Non-loopback binding requires a token; a public origin also requires TLS or --behind-tls-proxy");
  if (config.insecure_local) std::cerr << "WARNING: unauthenticated development listener; isolate it and publish to host loopback only\n";
  if (!config.check) for (const char* name : {"index.html", "viewer.js"})
    if (!std::filesystem::is_regular_file(std::filesystem::path(config.viewer)/name)) throw std::runtime_error("Viewer assets missing; use --viewer-dir");
  return true;
}
}  // namespace relay
