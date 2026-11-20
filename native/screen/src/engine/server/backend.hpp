#pragma once

#include "core/capture-source.hpp"
#include "core/input.hpp"
#include <memory>
#include <string>

namespace relay {
struct Backend {
  const char* name;
  bool (*initialize)(const std::string& output);
  std::unique_ptr<CaptureSource> (*capture)();
  std::unique_ptr<InputBackend> (*input)();
};
const Backend& defaultBackend();
const Backend& backendFor(const std::string& name);
std::string backendNames();
}
