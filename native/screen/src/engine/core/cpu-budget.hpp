#pragma once

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <limits>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(__linux__)
#include <sched.h>
#endif

namespace relay {
/** Reads a whole file, returning an empty string when it cannot be opened. */
inline std::string readText(const char* path) {
  std::ifstream file(path);
  return std::string(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
}

/** Reads one signed number from text, returning 0 when there is none. */
inline int64_t parseCount(const std::string& text) {
  std::istringstream fields(text);
  int64_t value = 0;
  return fields >> value ? value : 0;
}

/** CPUs implied by a quota and its period, or 0 when there is no limit. */
inline unsigned quotaCpus(uint64_t limit, uint64_t window) {
  if (!limit || !window) return 0;
  const uint64_t cpus = (limit - 1) / window + 1;
  return unsigned(std::min<uint64_t>(cpus, std::numeric_limits<unsigned>::max()));
}

/** Decodes the octal escapes the kernel writes for spaces and control characters in mount fields. */
inline std::string decodeMountField(const std::string& field) {
  std::string out;
  for (size_t i = 0; i < field.size(); ++i) {
    const auto octal = [&](size_t at) { return field[at] >= '0' && field[at] <= '7'; };
    if (field[i] == '\\' && i + 3 < field.size() && octal(i + 1) && octal(i + 2) && octal(i + 3)) {
      out.push_back(char((field[i + 1] - '0') * 64 + (field[i + 2] - '0') * 8 + (field[i + 3] - '0')));
      i += 3;
    } else {
      out.push_back(field[i]);
    }
  }
  return out;
}

/** Whether a comma-separated cgroup controller list names one controller. */
inline bool hasController(const std::string& controllers, const std::string& name) {
  std::istringstream list(controllers);
  std::string item;
  while (std::getline(list, item, ',')) if (item == name) return true;
  return false;
}

/** Where one cgroup hierarchy is mounted and which cgroup that mount point is rooted at. */
struct CgroupMount {
  std::string root, point;
};

/** Finds the mount of the unified hierarchy, or of the v1 hierarchy carrying the cpu controller. */
inline CgroupMount findCgroupMount(const std::string& mountinfo, bool unified) {
  std::istringstream lines(mountinfo);
  std::string line;
  while (std::getline(lines, line)) {
    std::istringstream fields(line);
    std::string field, root, point;
    int index = 0;
    for (; fields >> field; ++index) {
      if (index == 3) root = field;
      if (index == 4) point = field;
      if (field == "-") break;
    }
    std::string type, source, options;
    if (field != "-" || !(fields >> type >> source)) continue;
    fields >> options;
    if (type != (unified ? "cgroup2" : "cgroup")) continue;
    if (!unified && !hasController(options, "cpu")) continue;
    return {decodeMountField(root), decodeMountField(point)};
  }
  return {};
}

/** Path of the process inside one cgroup hierarchy from /proc/self/cgroup, or an empty string. */
inline std::string cgroupPath(const std::string& selfCgroup, bool unified) {
  std::istringstream lines(selfCgroup);
  std::string line;
  while (std::getline(lines, line)) {
    const size_t first = line.find(':');
    const size_t second = first == std::string::npos ? first : line.find(':', first + 1);
    if (second == std::string::npos) continue;
    const std::string controllers = line.substr(first + 1, second - first - 1);
    if (unified ? controllers.empty() : hasController(controllers, "cpu")) return line.substr(second + 1);
  }
  return {};
}

/** Cgroup path relative to the root the hierarchy is mounted at; false when it lies outside that mount. */
inline bool relativeCgroupPath(std::string path, const std::string& root, std::string& relative) {
  if (path.empty()) path = "/";
  if (root != "/") {
    if (path == root) path = "/";
    else if (path.rfind(root + "/", 0) == 0) path.erase(0, root.size());
    else return false;
  }
  while (!path.empty() && path.front() == '/') path.erase(0, 1);
  relative = path;
  return true;
}

/** Joins a directory and a file name with one separator. */
inline std::string joinPath(const std::string& dir, const char* name) {
  if (dir.empty()) return name;
  return dir.back() == '/' ? dir + name : dir + "/" + name;
}

/** Files with this name in each cgroup from the hierarchy mount point down to the process's own cgroup. */
inline std::vector<std::string> cgroupFiles(const std::string& mountinfo, const std::string& selfCgroup,
                                            bool unified, const char* name) {
  std::vector<std::string> files;
  const CgroupMount mount = findCgroupMount(mountinfo, unified);
  if (mount.point.empty()) return files;
  std::string path;
  const std::string own = cgroupPath(selfCgroup, unified);
  if (!own.empty() && !relativeCgroupPath(own, mount.root, path)) return files;
  std::string dir = mount.point;
  files.push_back(joinPath(dir, name));
  while (!path.empty()) {
    const size_t slash = path.find('/');
    if (dir.empty() || dir.back() != '/') dir += '/';
    dir += path.substr(0, slash);
    path.erase(0, slash == std::string::npos ? path.size() : slash + 1);
    files.push_back(joinPath(dir, name));
  }
  return files;
}

/** CPUs implied by a quota and its period written as text, or 0 when there is no limit. */
inline unsigned quotaCpusText(const std::string& quota, const std::string& period) {
  const int64_t limit = parseCount(quota), window = parseCount(period);
  if (limit <= 0 || window <= 0) return 0;
  return quotaCpus(uint64_t(limit), uint64_t(window));
}

/** CPUs implied by the unified hierarchy quota, or 0 when the hierarchy reports no limit. */
inline unsigned unifiedQuotaCpus(const std::string& cpuMax) {
  std::istringstream fields(cpuMax);
  std::string quota, period;
  if (!(fields >> quota >> period) || quota == "max") return 0;
  return quotaCpusText(quota, period);
}

/** CPUs implied by the cgroup quota recorded under a /proc/self directory, or 0 when none applies. */
inline unsigned cgroupQuotaCpus(const std::string& proc = "/proc/self") {
  const std::string mountinfo = readText((proc + "/mountinfo").c_str());
  const std::string self = readText((proc + "/cgroup").c_str());
  unsigned quota = 0;
  const auto add = [&](unsigned cpus) { if (cpus) quota = quota ? std::min(quota, cpus) : cpus; };
  for (const std::string& file : cgroupFiles(mountinfo, self, true, "cpu.max"))
    add(unifiedQuotaCpus(readText(file.c_str())));
  const std::vector<std::string> quotas = cgroupFiles(mountinfo, self, false, "cpu.cfs_quota_us");
  const std::vector<std::string> periods = cgroupFiles(mountinfo, self, false, "cpu.cfs_period_us");
  for (size_t i = 0; i < quotas.size(); ++i)
    add(quotaCpusText(readText(quotas[i].c_str()), readText(periods[i].c_str())));
  return quota;
}

/** CPUs this thread is allowed to run on, which includes cpuset limits, or 0 when unknown. */
inline unsigned affinityCpus() {
#if defined(__linux__)
  cpu_set_t mask;
  CPU_ZERO(&mask);
  if (sched_getaffinity(0, sizeof(mask), &mask) == 0 && CPU_COUNT(&mask) > 0) return unsigned(CPU_COUNT(&mask));
#endif
  return 0;
}

/** CPUs this process may use: the smallest of its cgroup quota, CPU affinity, and online CPUs. */
inline unsigned availableCpus() {
  unsigned cpus = std::max(1u, std::thread::hardware_concurrency());
  if (const unsigned affinity = affinityCpus()) cpus = std::min(cpus, affinity);
  if (const unsigned quota = cgroupQuotaCpus()) cpus = std::min(cpus, quota);
  return cpus;
}

/** Sliced threads x264 can use for a frame: one slice per four macroblock rows. */
inline unsigned sliceLimit(int height) { return std::max(1u, unsigned((height + 15) / 16 / 4)); }

/** Slice threads that encode one frame in parallel, bounded by the CPU budget and the slice count. */
inline int encoderThreads(int height) { return int(std::min(availableCpus(), sliceLimit(height))); }
}  // namespace relay
