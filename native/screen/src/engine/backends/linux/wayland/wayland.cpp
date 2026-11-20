#include "wayland.hpp"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

namespace relay::wayland {
struct OutputInfo {
  wl_output* proxy = nullptr;
  std::string name;
  uint32_t version = 0;
  int width = 0;
  int height = 0;

  ~OutputInfo() {
    if (proxy) wl_output_destroy(proxy);
  }
};

namespace {
std::string selectedOutputName;

struct RegistryState {
  Connection* connection;
  std::vector<std::unique_ptr<OutputInfo>> outputs;
  bool outputListenerFailed = false;
};

void outputNoop(void*, wl_output*, int32_t, int32_t, int32_t, int32_t, int32_t,
                const char*, const char*, int32_t) {}
void outputNoop(void*, wl_output*) {}
void outputNoop(void*, wl_output*, int32_t) {}
void outputNoop(void*, wl_output*, const char*) {}

void outputMode(void* data, wl_output*, uint32_t flags, int32_t width, int32_t height, int32_t) {
  auto* output = static_cast<OutputInfo*>(data);
  if (flags & WL_OUTPUT_MODE_CURRENT) {
    output->width = width;
    output->height = height;
  }
}

void outputName(void* data, wl_output*, const char* name) {
  static_cast<OutputInfo*>(data)->name = name ? name : "";
}

const wl_output_listener outputListener = {
  outputNoop, outputMode, outputNoop, outputNoop, outputName, outputNoop
};

void global(void* data, wl_registry* registry, uint32_t name, const char* interface, uint32_t version) {
  auto* state = static_cast<RegistryState*>(data);
  auto& connection = *state->connection;
  if (state->outputListenerFailed) return;
  if (std::strcmp(interface, wl_shm_interface.name) == 0 && !connection.shm) {
    connection.shm = static_cast<wl_shm*>(wl_registry_bind(registry, name, &wl_shm_interface, std::min(version, 1u)));
  } else if (std::strcmp(interface, wl_output_interface.name) == 0) {
    auto output = std::make_unique<OutputInfo>();
    output->version = version;
    output->proxy = static_cast<wl_output*>(wl_registry_bind(registry, name, &wl_output_interface, std::min(version, 4u)));
    if (wl_output_add_listener(output->proxy, &outputListener, output.get()) < 0) {
      state->outputListenerFailed = true;
      return;
    }
    state->outputs.push_back(std::move(output));
  } else if (std::strcmp(interface, zwlr_screencopy_manager_v1_interface.name) == 0 && !connection.screencopyManager) {
    connection.screencopyManager = static_cast<zwlr_screencopy_manager_v1*>(wl_registry_bind(
      registry, name, &zwlr_screencopy_manager_v1_interface, std::min(version, 3u)));
  } else if (std::strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0 && !connection.virtualKeyboardManager) {
    connection.virtualKeyboardManager = static_cast<zwp_virtual_keyboard_manager_v1*>(wl_registry_bind(
      registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1));
  } else if (std::strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0 &&
             version >= 2 && !connection.virtualPointerManager) {
    connection.virtualPointerManager = static_cast<zwlr_virtual_pointer_manager_v1*>(wl_registry_bind(
      registry, name, &zwlr_virtual_pointer_manager_v1_interface, 2));
  }
}

void globalRemove(void*, wl_registry*, uint32_t) {}

const wl_registry_listener registryListener = {global, globalRemove};

std::string availableOutputs(const std::vector<std::unique_ptr<OutputInfo>>& outputs) {
  std::string names;
  for (const auto& output : outputs) {
    if (!names.empty()) names += ", ";
    names += output->name.empty() ? "<unnamed>" : output->name;
  }
  return names.empty() ? "(none)" : names;
}
}

Connection::Connection() {
  display = wl_display_connect(nullptr);
  if (!display) {
    const char* name = std::getenv("WAYLAND_DISPLAY");
    throw std::runtime_error("Cannot connect to Wayland display '" + std::string(name ? name : "wayland-0") +
                             "'; check WAYLAND_DISPLAY and XDG_RUNTIME_DIR");
  }
  try {
    initialize();
  } catch (...) {
    cleanup();
    throw;
  }
}

Connection::~Connection() { cleanup(); }

void Connection::initialize() {
  registry_ = wl_display_get_registry(display);
  if (!registry_) throw std::runtime_error("Could not get Wayland registry");
  RegistryState state{this, {}, false};
  if (wl_registry_add_listener(registry_, &registryListener, &state) < 0)
    throw std::runtime_error("Could not listen to Wayland registry");
  if (wl_display_roundtrip(display) < 0) throw std::runtime_error("Wayland registry roundtrip failed");
  if (state.outputListenerFailed) throw std::runtime_error("Could not listen to wl_output");
  if (wl_display_roundtrip(display) < 0) throw std::runtime_error("Wayland output roundtrip failed");
  if (state.outputListenerFailed) throw std::runtime_error("Could not listen to wl_output");
  auto selected = state.outputs.begin();
  if (!selectedOutputName.empty()) {
    selected = std::find_if(state.outputs.begin(), state.outputs.end(), [](const auto& output) {
      return output->name == selectedOutputName;
    });
    if (selected == state.outputs.end()) {
      std::string message = "Unknown Wayland output '" + selectedOutputName + "'; available outputs: " +
                            availableOutputs(state.outputs);
      if (std::any_of(state.outputs.begin(), state.outputs.end(), [](const auto& output) {
            return output->version < 4;
          }))
        message += "; output names require wl_output version 4";
      throw std::runtime_error(message);
    }
  } else if (selected == state.outputs.end()) {
    throw std::runtime_error("No Wayland outputs available; available outputs: (none)");
  }
  outputInfo_ = std::move(*selected);
  output = outputInfo_->proxy;
  width = outputInfo_->width;
  height = outputInfo_->height;
  wl_registry_destroy(registry_);
  registry_ = nullptr;
}

void Connection::cleanup() {
  if (virtualPointerManager) zwlr_virtual_pointer_manager_v1_destroy(virtualPointerManager);
  if (virtualKeyboardManager) zwp_virtual_keyboard_manager_v1_destroy(virtualKeyboardManager);
  if (screencopyManager) zwlr_screencopy_manager_v1_destroy(screencopyManager);
  if (shm) wl_shm_destroy(shm);
  if (registry_) wl_registry_destroy(registry_);
  outputInfo_.reset();
  if (display) wl_display_disconnect(display);
  virtualPointerManager = nullptr;
  virtualKeyboardManager = nullptr;
  screencopyManager = nullptr;
  shm = nullptr;
  registry_ = nullptr;
  output = nullptr;
  display = nullptr;
}

bool initializeNativeBackend(const std::string& output) {
  selectedOutputName = output;
  return true;
}
}
