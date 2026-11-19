#include "metrics.hpp"
#include "config.hpp"
#include <array>
#include <fstream>
#include <sstream>

namespace relay {
namespace {
bool readSmallFile(const char* path, std::string& text) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return false;
  std::array<char, 16384> buffer{};
  file.read(buffer.data(), buffer.size());
  const auto count = file.gcount();
  if (file.bad() || (!file.eof() && file.peek() != std::char_traits<char>::eof())) return false;
  text.assign(buffer.data(), size_t(count));
  return !text.empty();
}
}  // namespace
bool statValue(const std::string& text, const std::string& wanted, uint64_t& value) {
  std::istringstream lines(text);
  std::string line;
  bool found = false;
  while (std::getline(lines, line)) {
    std::istringstream fields(line);
    std::string key, number, extra;
    if (!(fields >> key) || key != wanted) continue;
    if (found || !(fields >> number) || (fields >> extra) || !unsignedNumber(number, value)) return false;
    found = true;
  }
  return found;
}
bool cgroupMetrics(std::string& json) {
  std::string cpu, memory, memoryStats;
  uint64_t usage = 0, current = 0, inactive = 0;
  if (!readSmallFile("/sys/fs/cgroup/cpu.stat", cpu) ||
      !readSmallFile("/sys/fs/cgroup/memory.current", memory) ||
      !readSmallFile("/sys/fs/cgroup/memory.stat", memoryStats)) return false;
  const auto first = memory.find_first_not_of(" \t\r\n");
  const auto last = memory.find_last_not_of(" \t\r\n");
  if (first == std::string::npos || !unsignedNumber(memory.substr(first, last-first+1), current) ||
      !statValue(cpu, "usage_usec", usage) || !statValue(memoryStats, "inactive_file", inactive)) return false;
  json = "{\"usage_usec\":"+std::to_string(usage)+",\"memory_current\":"+std::to_string(current)+
         ",\"inactive_file\":"+std::to_string(inactive)+"}";
  return true;
}
}  // namespace relay
