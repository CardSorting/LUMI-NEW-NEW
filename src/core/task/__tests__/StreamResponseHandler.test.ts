import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import {
	extractFirstCompleteJsonRoot,
	extractJsonRoots,
	StreamResponseHandler,
	ToolArgumentError,
} from "../StreamResponseHandler"

describe("StreamResponseHandler - ToolUseHandler robustness & diagnostics", () => {
	it("deduplicates identical concatenated snapshots during processToolUseDelta", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		// Delta 1
		handler.processToolUseDelta({
			id: "call-1",
			type: "tool_use",
			name: "list_files",
			input: '{"path": "."}',
		})
		// Delta 2 (duplicate snapshot of the same input)
		handler.processToolUseDelta({
			id: "call-1",
			type: "tool_use",
			name: "list_files",
			input: '{"path": "."}',
		})

		assert.doesNotThrow(() => handler.assertCompleteToolUses())
		const toolUses = handler.getAllFinalizedToolUses()
		assert.equal(toolUses.length, 1)
		assert.deepEqual(toolUses[0].input, { path: "." })
	})

	it("slices snapshot when delta is an extension of accumulated input", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		// Incremental delta
		handler.processToolUseDelta({
			id: "call-2",
			type: "tool_use",
			name: "read_file",
			input: '{"path":',
		})
		// Full snapshot containing prefix
		handler.processToolUseDelta({
			id: "call-2",
			type: "tool_use",
			name: "read_file",
			input: '{"path": "index.ts"}',
		})

		assert.doesNotThrow(() => handler.assertCompleteToolUses())
		const toolUses = handler.getAllFinalizedToolUses()
		assert.equal(toolUses.length, 1)
		assert.deepEqual(toolUses[0].input, { path: "index.ts" })
	})

	it("self-heals when assertCompleteToolUses encounters identical duplicate snapshots", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		// Manually inject concatenated snapshots directly
		;(handler as any).pendingToolUses.set("call-3", {
			id: "call-3",
			name: "attempt_completion",
			input: '{"result": "Done"}{"result": "Done"}',
			call_id: "call-3",
		})

		assert.doesNotThrow(() => handler.assertCompleteToolUses())
		const finalized = handler.getFinalizedToolUse("call-3")
		assert.deepEqual(finalized?.input, { result: "Done" })
	})

	it("self-heals duplicate snapshots containing nested JSON objects", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-nested", {
			id: "call-nested",
			name: "apply_diff",
			input: '{"options": {"context": 3, "verbose": true}}{"options": {"context": 3, "verbose": true}}',
			call_id: "call-nested",
		})

		assert.doesNotThrow(() => handler.assertCompleteToolUses())
		const finalized = handler.getFinalizedToolUse("call-nested")
		assert.deepEqual(finalized?.input, { options: { context: 3, verbose: true } })
	})

	it("self-heals duplicate snapshots containing braces inside string values", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-braces-in-str", {
			id: "call-braces-in-str",
			name: "execute_command",
			input: '{"command": "awk \'{print $1}\' file.txt"}{"command": "awk \'{print $1}\' file.txt"}',
			call_id: "call-braces-in-str",
		})

		assert.doesNotThrow(() => handler.assertCompleteToolUses())
		const finalized = handler.getFinalizedToolUse("call-braces-in-str")
		assert.deepEqual(finalized?.input, { command: "awk '{print $1}' file.txt" })
	})

	it("self-heals across more than two duplicate snapshots and whitespace", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-multi-snap", {
			id: "call-multi-snap",
			name: "list_files",
			input: '{"path": "."}\n\n{"path": "."}\n{"path": "."}',
			call_id: "call-multi-snap",
		})

		assert.doesNotThrow(() => handler.assertCompleteToolUses())
		const finalized = handler.getFinalizedToolUse("call-multi-snap")
		assert.deepEqual(finalized?.input, { path: "." })
	})

	it("self-heals duplicate snapshots with formatting / spacing variations", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-spacing", {
			id: "call-spacing",
			name: "list_files",
			input: '{"path": "src"}{"path":"src"}',
			call_id: "call-spacing",
		})

		assert.doesNotThrow(() => handler.assertCompleteToolUses())
		const finalized = handler.getFinalizedToolUse("call-spacing")
		assert.deepEqual(finalized?.input, { path: "src" })
	})

	it("diagnoses concatenated non-identical snapshots with ToolArgumentError (kind: concatenation)", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-4", {
			id: "call-4",
			name: "list_files",
			input: '{"path": "a"}{"path": "b"}',
			call_id: "call-4",
		})

		assert.throws(
			() => handler.assertCompleteToolUses(),
			(err: any) => {
				assert.ok(err instanceof ToolArgumentError)
				assert.equal(err.kind, "concatenation")
				assert.equal(err.toolName, "list_files")
				assert.match(err.message, /detected concatenated tool call arguments or duplicate snapshots/)
				return true
			},
		)
	})

	it("diagnoses incomplete tool arguments with ToolArgumentError (kind: incomplete)", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-5", {
			id: "call-5",
			name: "read_file",
			input: '{"path": "incomp',
			call_id: "call-5",
		})

		assert.throws(
			() => handler.assertCompleteToolUses(),
			(err: any) => {
				assert.ok(err instanceof ToolArgumentError)
				assert.equal(err.kind, "incomplete")
				assert.equal(err.toolName, "read_file")
				assert.match(err.message, /Incomplete arguments for tool read_file; the call was not executed\./)
				return true
			},
		)
	})

	it("diagnoses empty arguments with ToolArgumentError (kind: incomplete)", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-6", {
			id: "call-6",
			name: "read_file",
			input: "   ",
			call_id: "call-6",
		})

		assert.throws(
			() => handler.assertCompleteToolUses(),
			(err: any) => {
				assert.ok(err instanceof ToolArgumentError)
				assert.equal(err.kind, "incomplete")
				assert.match(err.message, /Incomplete arguments for tool read_file; the call was not executed\./)
				return true
			},
		)
	})

	it("diagnoses malformed syntax with ToolArgumentError (kind: syntax)", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-7", {
			id: "call-7",
			name: "write_file",
			input: "{not_valid_json: true}",
			call_id: "call-7",
		})

		assert.throws(
			() => handler.assertCompleteToolUses(),
			(err: any) => {
				assert.ok(err instanceof ToolArgumentError)
				assert.equal(err.kind, "syntax")
				assert.equal(err.toolName, "write_file")
				assert.match(err.message, /syntax error in tool arguments/)
				return true
			},
		)
	})

	it("diagnoses non-object JSON with ToolArgumentError (kind: invalid_format)", () => {
		const handler = new StreamResponseHandler().getHandlers().toolUseHandler
		;(handler as any).pendingToolUses.set("call-8", {
			id: "call-8",
			name: "write_file",
			input: '["array_not_object"]',
			call_id: "call-8",
		})

		assert.throws(
			() => handler.assertCompleteToolUses(),
			(err: any) => {
				assert.ok(err instanceof ToolArgumentError)
				assert.equal(err.kind, "invalid_format")
				assert.match(err.message, /Invalid arguments for tool write_file; expected a JSON object\./)
				return true
			},
		)
	})

	it("extractFirstCompleteJsonRoot correctly extracts root value when followed by concatenated content", () => {
		const root = extractFirstCompleteJsonRoot('{"a": 1, "b": "hello"}{"c": 2}')
		assert.deepEqual(root, { a: 1, b: "hello" })
	})

	it("extractFirstCompleteJsonRoot returns undefined for incomplete JSON", () => {
		assert.equal(extractFirstCompleteJsonRoot('{"a": 1'), undefined)
	})

	it("extractJsonRoots parses multiple roots with offsets, nested structures, and braces in strings", () => {
		const raw = '  {"nested": {"foo": "bar"}} \n {"cmd": "awk \'{print $1}\'"} extra'
		const result = extractJsonRoots(raw)
		assert.equal(result.roots.length, 2)
		assert.deepEqual(result.roots[0].value, { nested: { foo: "bar" } })
		assert.equal(result.roots[0].raw, '{"nested": {"foo": "bar"}}')
		assert.deepEqual(result.roots[1].value, { cmd: "awk '{print $1}'" })
		assert.equal(result.remainder, "extra")
	})
})
