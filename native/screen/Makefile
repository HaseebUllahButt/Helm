CXX ?= g++
ifeq ($(OS),Windows_NT)
BACKENDS ?= windows
endif
ifeq ($(shell uname -s),Darwin)
BACKENDS ?= macos
PLATFORM_PKGS = openssl
endif
BACKENDS ?= x11
HAS_WAYLAND = $(filter wayland,$(BACKENDS))
AVAILABLE_BACKENDS = x11 wayland windows macos
BACKEND_PKGS_x11 = x11 xext xdamage xfixes xtst
BACKEND_DIR_x11 = linux/x11
BACKEND_PKGS_wayland = wayland-client xkbcommon
BACKEND_DIR_wayland = linux/wayland
BACKEND_DIR_windows = windows
BACKEND_LIBS_windows = -ld3d11 -ldxgi -lbcrypt
BACKEND_FLAGS_windows = -DNOMINMAX -D_WIN32_WINNT=0x0A00
BACKEND_DIR_macos = macos
BACKEND_FLAGS_macos = -mmacosx-version-min=12.3 -Werror=unguarded-availability-new
BACKEND_LIBS_macos = -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo -framework CoreGraphics -framework ApplicationServices -framework AppKit -framework Foundation
ifneq ($(filter-out $(AVAILABLE_BACKENDS),$(BACKENDS)),)
$(error Unknown BACKENDS '$(filter-out $(AVAILABLE_BACKENDS),$(BACKENDS))'; available: $(AVAILABLE_BACKENDS))
endif
ifeq ($(strip $(BACKENDS)),)
$(error BACKENDS must name at least one backend; available: $(AVAILABLE_BACKENDS))
endif
BACKEND_PKGS = $(sort $(foreach backend,$(BACKENDS),$(BACKEND_PKGS_$(backend))))
BACKEND_DIRS = $(sort $(foreach backend,$(BACKENDS),$(BACKEND_DIR_$(backend))))
BACKEND_CPPFLAGS = $(foreach backend,$(sort $(BACKENDS)),-DRELAY_BACKEND_$(backend) $(BACKEND_FLAGS_$(backend)))
CODEC_PKGS = x264
PKGS = $(sort $(BACKEND_PKGS) $(CODEC_PKGS) $(PLATFORM_PKGS) libwebsockets zlib)
CPPFLAGS += -Isrc/engine $(BACKEND_CPPFLAGS) $(shell pkg-config --cflags $(PKGS))
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -Wall -Wextra -Wpedantic -pthread
BACKEND_LIBS = $(foreach backend,$(BACKENDS),$(BACKEND_LIBS_$(backend)))
LDLIBS += $(shell pkg-config --libs $(PKGS)) $(BACKEND_LIBS) -pthread

CORE_SRCS = $(wildcard src/engine/core/*.cpp)
BACKEND_SRCS = $(foreach dir,$(BACKEND_DIRS),$(wildcard src/engine/backends/$(dir)/*.cpp src/engine/backends/$(dir)/*.mm))
BACKEND_OBJCXXFLAGS = $(if $(filter %.mm,$(BACKEND_SRCS)),-fobjc-arc)
ENGINE_SRCS = $(CORE_SRCS) $(wildcard src/engine/server/*.cpp) $(BACKEND_SRCS)
HEADERS = $(wildcard src/engine/*/*.hpp src/engine/backends/linux/*.hpp) $(foreach dir,$(BACKEND_DIRS),$(wildcard src/engine/backends/$(dir)/*.hpp))

WAYLAND_PROTOCOLS = wlr-screencopy-unstable-v1 wlr-virtual-pointer-unstable-v1 virtual-keyboard-unstable-v1
.PHONY: all deps install test test-color test-flow test-capture-bucket test-cpu-budget test-input test-backend test-server test-keymap test-macos-keys clean FORCE
all: relay-engine

ifeq ($(HAS_WAYLAND),wayland)
WAYLAND_SCANNER = $(shell pkg-config --variable=wayland_scanner wayland-scanner)
WAYLAND_PROTOCOL_HEADERS = $(addprefix build/protocols/,$(addsuffix -client-protocol.h,$(WAYLAND_PROTOCOLS)))
WAYLAND_PROTOCOL_SOURCES = $(addprefix build/protocols/,$(addsuffix -protocol.c,$(WAYLAND_PROTOCOLS)))
WAYLAND_PROTOCOL_OBJECTS = $(addprefix build/protocols/,$(addsuffix -protocol.o,$(WAYLAND_PROTOCOLS)))
CPPFLAGS += -Ibuild/protocols

$(WAYLAND_PROTOCOL_HEADERS): build/protocols/%-client-protocol.h: src/engine/backends/linux/wayland/protocols/%.xml
	mkdir -p $(@D)
	$(WAYLAND_SCANNER) client-header $< $@

$(WAYLAND_PROTOCOL_SOURCES): build/protocols/%-protocol.c: src/engine/backends/linux/wayland/protocols/%.xml
	mkdir -p $(@D)
	$(WAYLAND_SCANNER) private-code $< $@

$(WAYLAND_PROTOCOL_OBJECTS): build/protocols/%-protocol.o: build/protocols/%-protocol.c build/protocols/%-client-protocol.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(ENGINE_SRCS): $(WAYLAND_PROTOCOL_HEADERS)
endif

deps:
	@$(CXX) --version >/dev/null 2>&1
	@pkg-config --exists --print-errors $(PKGS) $(if $(HAS_WAYLAND),wayland-scanner)

PREFIX ?= /usr/local

install: relay-engine
	@test -f dist/viewer/viewer.js || { echo 'Run npm run build first (dist/viewer is missing).' >&2; exit 1; }
	install -d "$(DESTDIR)$(PREFIX)/lib/relay/viewer" "$(DESTDIR)$(PREFIX)/bin"
	install -m 0755 relay-engine "$(DESTDIR)$(PREFIX)/lib/relay/relay-engine"
	install -m 0644 dist/viewer/index.html dist/viewer/viewer.js "$(DESTDIR)$(PREFIX)/lib/relay/viewer/"
	ln -sfn ../lib/relay/relay-engine "$(DESTDIR)$(PREFIX)/bin/relay-engine"

build/backends: FORCE
	mkdir -p build
	@printf '%s\n' '$(strip $(BACKENDS))' | cmp -s - $@ || printf '%s\n' '$(strip $(BACKENDS))' > $@

FORCE:

relay-engine: $(ENGINE_SRCS) $(HEADERS) $(WAYLAND_PROTOCOL_OBJECTS) build/backends
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(BACKEND_OBJCXXFLAGS) $(ENGINE_SRCS) $(WAYLAND_PROTOCOL_OBJECTS) -o $@ $(LDLIBS)

build/color-test: tests/unit/color-test.cpp src/engine/core/color.cpp src/engine/core/color.hpp
	mkdir -p build
	$(CXX) -Isrc/engine $(CXXFLAGS) tests/unit/color-test.cpp src/engine/core/color.cpp -o $@

test-color: build/color-test
	./build/color-test

build/flow-test: tests/unit/flow-test.cpp src/engine/core/flow.hpp
	mkdir -p build
	$(CXX) -Isrc/engine $(CXXFLAGS) tests/unit/flow-test.cpp -o $@

test-flow: build/flow-test
	./build/flow-test

build/capture-bucket-test: tests/unit/capture-bucket-test.cpp src/engine/core/capture-bucket.hpp
	mkdir -p build
	$(CXX) -Isrc/engine $(CXXFLAGS) tests/unit/capture-bucket-test.cpp -o $@

test-capture-bucket: build/capture-bucket-test
	./build/capture-bucket-test

build/cpu-budget-test: tests/unit/cpu-budget-test.cpp src/engine/core/cpu-budget.hpp
	mkdir -p build
	$(CXX) -Isrc/engine $(CXXFLAGS) tests/unit/cpu-budget-test.cpp -o $@

test-cpu-budget: build/cpu-budget-test
	./build/cpu-budget-test

build/input-test: tests/unit/input-test.cpp src/engine/core/input.cpp src/engine/core/input.hpp
	mkdir -p build
	$(CXX) -Isrc/engine $(CXXFLAGS) tests/unit/input-test.cpp src/engine/core/input.cpp -o $@

test-input: build/input-test
	./build/input-test

build/backend-source-test: tests/unit/backend-source-test.cpp $(CORE_SRCS) $(wildcard src/engine/core/*.hpp)
	mkdir -p build
	$(CXX) -Isrc/engine $(CXXFLAGS) tests/unit/backend-source-test.cpp $(CORE_SRCS) -o $@ $(shell pkg-config --cflags --libs $(CODEC_PKGS) libavcodec libavutil libswscale)

test-backend: build/backend-source-test
	./build/backend-source-test

SERVER_TEST_SRCS = src/engine/server/config.cpp src/engine/server/metrics.cpp src/engine/server/wire.cpp src/engine/server/backend.cpp src/engine/core/input.cpp src/engine/core/wait.cpp $(BACKEND_SRCS)

build/test-viewer/viewer.js:
	mkdir -p build/test-viewer
	: > build/test-viewer/index.html
	: > build/test-viewer/viewer.js

build/server-test: tests/unit/server-test.cpp $(SERVER_TEST_SRCS) $(HEADERS) $(WAYLAND_PROTOCOL_HEADERS) $(WAYLAND_PROTOCOL_OBJECTS) build/test-viewer/viewer.js build/backends
	mkdir -p build
	$(CXX) -Isrc/engine $(BACKEND_CPPFLAGS) $(if $(HAS_WAYLAND),-Ibuild/protocols) $(shell pkg-config --cflags $(BACKEND_PKGS) $(PLATFORM_PKGS) libwebsockets) $(CXXFLAGS) $(BACKEND_OBJCXXFLAGS) tests/unit/server-test.cpp $(SERVER_TEST_SRCS) $(WAYLAND_PROTOCOL_OBJECTS) -o $@ $(shell pkg-config --libs $(BACKEND_PKGS) $(PLATFORM_PKGS) libwebsockets) $(BACKEND_LIBS)

test-server: build/server-test
	./build/server-test

build/keymap-test: tests/unit/keymap-test.cpp src/engine/backends/linux/wayland/keymap.cpp
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(shell pkg-config --cflags xkbcommon) $^ -o $@ $(shell pkg-config --libs xkbcommon)

test-keymap: build/keymap-test
	./build/keymap-test

build/macos-keys-test: tests/unit/macos-keys-test.cpp src/engine/backends/macos/keys.hpp src/engine/backends/linux/keycodes.hpp
	mkdir -p build
	$(CXX) -Isrc/engine $(CXXFLAGS) tests/unit/macos-keys-test.cpp -o $@ -framework Carbon -framework CoreFoundation

test-macos-keys: build/macos-keys-test
	./build/macos-keys-test

test: test-color test-flow test-capture-bucket test-cpu-budget test-input test-backend test-server $(if $(HAS_WAYLAND),test-keymap) $(if $(filter macos,$(BACKENDS)),test-macos-keys)

clean:
	rm -rf build relay-engine
