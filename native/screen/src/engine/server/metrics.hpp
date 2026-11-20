#pragma once

#include <cstdint>
#include <string>

namespace relay {
bool statValue(const std::string& text, const std::string& wanted, uint64_t& value);
/** Reads cgroup v2 usage into a JSON object; returns false when any file is missing or malformed. */
bool cgroupMetrics(std::string& json);
}  // namespace relay
