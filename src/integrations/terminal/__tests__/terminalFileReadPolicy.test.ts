import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { detectTerminalFileRead, isTerminalFileReadCommand, splitTopLevelStatements } from "../terminalFileReadPolicy"

describe("terminalFileReadPolicy", () => {
	describe("splitTopLevelStatements", () => {
		it("splits simple commands by semicolon and newline", () => {
			const cmd = "echo 1; echo 2\necho 3"
			const stmts = splitTopLevelStatements(cmd)
			assert.deepStrictEqual(stmts, ["echo 1", "echo 2", "echo 3"])
		})

		it("splits compound commands with && and ||", () => {
			const cmd = "mkdir -p dir && cd dir || exit 1"
			const stmts = splitTopLevelStatements(cmd)
			assert.deepStrictEqual(stmts, ["mkdir -p dir", "cd dir", "exit 1"])
		})

		it("preserves semicolons and operators inside quotes", () => {
			const cmd = "printf \"hello; world\" && echo 'test && 123'"
			const stmts = splitTopLevelStatements(cmd)
			assert.deepStrictEqual(stmts, ['printf "hello; world"', "echo 'test && 123'"])
		})

		it("extracts subshells and command substitutions", () => {
			const cmd = "echo $(cat secret.txt) && (cd /tmp && cat data.json)"
			const stmts = splitTopLevelStatements(cmd)
			assert.ok(stmts.includes("cat secret.txt"))
			assert.ok(stmts.includes("cd /tmp"))
			assert.ok(stmts.includes("cat data.json"))
		})

		it("strips workspace prefix safely", () => {
			const cmd = "@workspace:cat src/main.c"
			const stmts = splitTopLevelStatements(cmd)
			assert.deepStrictEqual(stmts, ["cat src/main.c"])
		})
	})

	describe("detectTerminalFileRead", () => {
		it("detects the runlog.md craft-floor cat command", () => {
			const cmd = "cat /Users/bozoegg/.agents/skills/impeccable/reference/craft-floor.md"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["/Users/bozoegg/.agents/skills/impeccable/reference/craft-floor.md"])
			assert.ok(res.reason?.includes("read_file"))
		})

		it("detects the runlog.md compound find and multiple cat commands", () => {
			const cmd =
				"find . -maxdepth 3 -type f -print; printf '\\n--- main ---\\n'; cat src/main.c; printf '\\n--- game ---\\n'; cat src/game.c; printf '\\n--- header ---\\n'; cat src/game.h"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["src/main.c", "src/game.c", "src/game.h"])
			assert.ok(res.reason?.includes("read_file"))
		})

		it("detects the runlog.md node script chained with reference cat", () => {
			const cmd =
				"node /Users/bozoegg/.agents/skills/impeccable/scripts/context.mjs; printf '\\n--- NEW WORK ---\\n'; cat /Users/bozoegg/.agents/skills/impeccable/reference/new-work.md"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["/Users/bozoegg/.agents/skills/impeccable/reference/new-work.md"])
		})

		it("detects standalone cat on workspace source files", () => {
			const cmd = "cat src/game.c"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["src/game.c"])
		})

		it("detects head on files", () => {
			const cmd = "head -n 25 README.md"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["README.md"])
		})

		it("detects tail without -f on files", () => {
			const cmd = "tail -n 50 debug.log"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["debug.log"])
		})

		it("detects more and less on files", () => {
			assert.strictEqual(detectTerminalFileRead("more config.json").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("less src/index.ts").isTerminalFileRead, true)
		})

		it("detects alternative file dumping utilities (tac, bat, nl, fold, pr)", () => {
			assert.strictEqual(detectTerminalFileRead("tac src/game.c").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("bat README.md").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("nl src/main.c").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("fold -w 80 doc.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("pr doc.txt").isTerminalFileRead, true)
		})

		it("detects commands wrapped in subshells and groupings", () => {
			assert.strictEqual(detectTerminalFileRead("(cat file.txt)").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("{ cat file.txt; }").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("(cd dir && cat file.txt)").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("echo $(cat file.txt)").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("echo `cat file.txt`").isTerminalFileRead, true)
		})

		it("detects commands with wrappers (env, command, sudo, doas, nohup, time, exec)", () => {
			assert.strictEqual(detectTerminalFileRead("env cat file.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("env FOO=1 cat file.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("command cat file.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("command -p cat file.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("sudo cat file.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("nohup cat file.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("time cat file.txt").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("exec cat file.txt").isTerminalFileRead, true)
		})

		it("detects commands preceded by @workspace: prefix", () => {
			const res = detectTerminalFileRead("@workspace:cat src/main.c")
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["src/main.c"])
		})

		it("detects terminal dumping pipelines (piped to cat, more, less, head, tail, tee)", () => {
			assert.strictEqual(detectTerminalFileRead("cat file.txt | cat").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | more").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | less").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | head -n 50").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | tail -n 50").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | tee").isTerminalFileRead, true)
			assert.strictEqual(detectTerminalFileRead("echo foo | cat file.txt").isTerminalFileRead, true)
		})

		it("detects input redirection (< file and cat < file) without corrupted target names", () => {
			const res1 = detectTerminalFileRead("cat < file.txt")
			assert.strictEqual(res1.isTerminalFileRead, true)
			assert.deepStrictEqual(res1.targetFiles, ["file.txt"])

			const res2 = detectTerminalFileRead("cat <file.txt")
			assert.strictEqual(res2.isTerminalFileRead, true)
			assert.deepStrictEqual(res2.targetFiles, ["file.txt"])

			const res3 = detectTerminalFileRead("< file.txt")
			assert.strictEqual(res3.isTerminalFileRead, true)
			assert.deepStrictEqual(res3.targetFiles, ["file.txt"])
		})

		it("detects interactive cat > file without heredoc or input", () => {
			const cmd = "cat > output.txt"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.ok(res.reason?.includes("write_to_file"))
		})

		it("does not flag filtering pipelines (grep, wc, awk, sed, jq, etc.)", () => {
			assert.strictEqual(detectTerminalFileRead("cat package.json | grep '\"version\"'").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | wc -l").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | awk '{print $1}'").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | jq .").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat file.txt | sort | uniq").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cmake --version | head -1").isTerminalFileRead, false)
		})

		it("does not flag here-string constructs (cat <<< 'text')", () => {
			assert.strictEqual(detectTerminalFileRead("cat <<< 'some text'").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead('cat <<< "some text"').isTerminalFileRead, false)
		})

		it("does not flag cat redirected to another file", () => {
			const cmd = "cat a.txt b.txt > c.txt"
			const res = detectTerminalFileRead(cmd)
			assert.strictEqual(res.isTerminalFileRead, false)
		})

		it("does not flag whitelisted system info probes (/proc/*, /etc/os-release)", () => {
			assert.strictEqual(detectTerminalFileRead("cat /proc/cpuinfo").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat /proc/version").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat /etc/os-release").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat /etc/issue").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cat /dev/null").isTerminalFileRead, false)
		})

		it("does not flag streaming tail -f", () => {
			const cmd = "tail -f /var/log/system.log"
			assert.strictEqual(detectTerminalFileRead(cmd).isTerminalFileRead, false)
		})

		it("does not flag normal shell commands", () => {
			assert.strictEqual(detectTerminalFileRead("npm test").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("git status").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("find . -name '*.c'").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("echo 'cat'").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead("cmake --build build").isTerminalFileRead, false)
		})

		it("detects command substitutions inside double quotes", () => {
			const res1 = detectTerminalFileRead('echo "$(cat src/main.c)"')
			assert.strictEqual(res1.isTerminalFileRead, true)
			assert.deepStrictEqual(res1.targetFiles, ["src/main.c"])

			const res2 = detectTerminalFileRead('printf "%s\\n" "$(cat file.txt)"')
			assert.strictEqual(res2.isTerminalFileRead, true)
			assert.deepStrictEqual(res2.targetFiles, ["file.txt"])

			const res3 = detectTerminalFileRead('VAR="`cat data.json`"')
			assert.strictEqual(res3.isTerminalFileRead, true)
			assert.deepStrictEqual(res3.targetFiles, ["data.json"])
		})

		it("detects terminal reads even when stderr is redirected (2> /dev/null)", () => {
			const res1 = detectTerminalFileRead("cat file.txt 2> /dev/null")
			assert.strictEqual(res1.isTerminalFileRead, true)
			assert.deepStrictEqual(res1.targetFiles, ["file.txt"])

			const res2 = detectTerminalFileRead("cat file.txt 2> err.log")
			assert.strictEqual(res2.isTerminalFileRead, true)
			assert.deepStrictEqual(res2.targetFiles, ["file.txt"])

			const res3 = detectTerminalFileRead("cat file.txt 2>&1")
			assert.strictEqual(res3.isTerminalFileRead, true)
			assert.deepStrictEqual(res3.targetFiles, ["file.txt"])
		})

		it("does not flag cat when stdout is redirected to file even if stderr is also redirected", () => {
			const res = detectTerminalFileRead("cat file.txt > out.txt 2> /dev/null")
			assert.strictEqual(res.isTerminalFileRead, false)
		})

		it("detects stdin redirection with explicit fd 0 (0< file.txt) without bogus tokens", () => {
			const res = detectTerminalFileRead("cat 0< file.txt")
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["file.txt"])
		})

		it("handles escaped quotes in here-strings and redirection cleanly", () => {
			assert.strictEqual(detectTerminalFileRead('cat <<< "hello \\"world\\""').isTerminalFileRead, false)
			const res = detectTerminalFileRead('cat < "file with \\"quotes\\".txt"')
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ['file with "quotes".txt'])
		})

		it("detects subshell script wrappers (bash -c, sh -c)", () => {
			const res1 = detectTerminalFileRead('bash -c "cat src/main.c"')
			assert.strictEqual(res1.isTerminalFileRead, true)
			assert.deepStrictEqual(res1.targetFiles, ["src/main.c"])

			const res2 = detectTerminalFileRead("sh -c 'cat src/game.c'")
			assert.strictEqual(res2.isTerminalFileRead, true)
			assert.deepStrictEqual(res2.targetFiles, ["src/game.c"])
		})

		it("detects terminal file dumpers via xargs", () => {
			const res1 = detectTerminalFileRead('find . -name "*.c" | xargs cat')
			assert.strictEqual(res1.isTerminalFileRead, true)
			assert.ok(res1.reason?.includes("xargs"))

			const res2 = detectTerminalFileRead('find . -name "*.c" | xargs -n 1 head')
			assert.strictEqual(res2.isTerminalFileRead, true)
			assert.ok(res2.reason?.includes("xargs"))
		})

		it("detects terminal file dumpers via find -exec", () => {
			const res1 = detectTerminalFileRead('find . -name "*.c" -exec cat {} +')
			assert.strictEqual(res1.isTerminalFileRead, true)
			assert.ok(res1.reason?.includes("find -exec"))

			const res2 = detectTerminalFileRead('find . -name "*.c" -exec cat {} \\;')
			assert.strictEqual(res2.isTerminalFileRead, true)
			assert.ok(res2.reason?.includes("find -exec"))
		})

		it("detects view as an interactive terminal file reader", () => {
			const res = detectTerminalFileRead("view src/main.c")
			assert.strictEqual(res.isTerminalFileRead, true)
			assert.deepStrictEqual(res.targetFiles, ["src/main.c"])
		})

		it("handles empty and non-string inputs safely", () => {
			assert.strictEqual(detectTerminalFileRead("").isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead(null as any).isTerminalFileRead, false)
			assert.strictEqual(detectTerminalFileRead(undefined as any).isTerminalFileRead, false)
		})
	})

	describe("isTerminalFileReadCommand", () => {
		it("returns true for terminal file reads", () => {
			assert.strictEqual(isTerminalFileReadCommand("cat src/main.c"), true)
		})

		it("returns false for non-file read commands", () => {
			assert.strictEqual(isTerminalFileReadCommand("npm run build"), false)
		})
	})
})
