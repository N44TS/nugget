.PHONY: build

build:
	@if [ -f wasm/workflow.wasm ]; then \
		echo "Using prebuilt wasm/workflow.wasm — skipping compile"; \
	else \
		bun cre-compile main.ts wasm/workflow.wasm; \
	fi