# Changelog

All notable changes are documented here.


## test/extend-test-coverage

Extended test coverage to the Excalidraw extension by integrating extension tests into the main test script (#75). Refactored Excalidraw prompt content into standalone markdown files (`element-format.md`, `draw-instruction.md`) for better maintainability and modularity. Implemented a comprehensive Excalidraw diagram preview tool with `draw_diagram` and `save_diagram` capabilities, streaming element rendering with throttling, checkpoint management for diagram persistence, and clipboard export (PNG/SVG). The extension includes a webview-based live preview window powered by @excalidraw/excalidraw with support for macOS PNG clipboard operations and graceful error handling for partial JSON streaming.
