import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { detectHeredocFileRedirection, findTopLevelHeredocs, isMultilineHeredocCommand } from "../heredocPolicy"

describe("heredocPolicy", () => {
	describe("detectHeredocFileRedirection", () => {
		it("detects the user's multiline chained heredoc file write command", () => {
			const command = [
				"cat > game.c <<'EOF'",
				"#include <stdio.h>",
				'int main() { printf("Hello\\n"); return 0; }',
				"EOF",
				"cat > Makefile <<'EOF'",
				"all:",
				"\tgcc -o game game.c",
				"clean:",
				"\trm -f game",
				"EOF",
				"cat > tests.c <<'EOF'",
				"#include <assert.h>",
				"int main() { assert(1); return 0; }",
				"EOF",
				"make clean all test",
			].join("\n")

			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["game.c", "Makefile", "tests.c"])
			assert.match(result.reason!, /write_to_file/)
			assert.match(result.reason!, /'game.c', 'Makefile', 'tests.c'/)
		})

		it("detects single file cat > file << 'EOF'", () => {
			const command = "cat > script.sh << 'EOF'\necho hi\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["script.sh"])
			assert.match(result.reason!, /script.sh/)
		})

		it("detects single file cat << 'EOF' > file", () => {
			const command = "cat << 'EOF' > output.txt\ncontent\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["output.txt"])
		})

		it("detects single file cat >> file << 'EOF' (append)", () => {
			const command = "cat >> log.txt << 'EOF'\nappend this\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["log.txt"])
		})

		it("detects files with spaces in quotes: cat > \"my game.c\" << 'EOF'", () => {
			const command = "cat > \"src/my game.c\" << 'EOF'\nint main(){}\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["src/my game.c"])
		})

		it("detects files with spaces in single quotes: cat << 'EOF' > 'dir/my file.txt'", () => {
			const command = "cat << 'EOF' > 'dir/my file.txt'\ncontent\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["dir/my file.txt"])
		})

		it("detects unspaced syntax: cat>game.c << 'EOF'", () => {
			const command = "cat>game.c << 'EOF'\nint main(){}\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["game.c"])
		})

		it("detects unspaced delimiter redirect: cat <<'EOF'>game.c and cat <<'EOF'>>game.c", () => {
			const command1 = "cat <<'EOF'>game.c\ncontent\nEOF"
			const result1 = detectHeredocFileRedirection(command1)
			assert.equal(result1.isHeredocFileWrite, true)
			assert.deepEqual(result1.targetFiles, ["game.c"])

			const command2 = "cat <<'EOF'>>game.c\ncontent\nEOF"
			const result2 = detectHeredocFileRedirection(command2)
			assert.equal(result2.isHeredocFileWrite, true)
			assert.deepEqual(result2.targetFiles, ["game.c"])
		})

		it("detects sudo tee with spaces in filename", () => {
			const command = "sudo tee \"my server config.yaml\" << 'EOF'\nport: 8080\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["my server config.yaml"])
		})

		it("detects piped heredoc to sudo tee", () => {
			const command = "cat << 'EOF' | sudo tee /etc/systemd/system/app.service\n[Unit]\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["/etc/systemd/system/app.service"])
		})

		it("detects piped heredoc to cat redirection", () => {
			const command = "cat << 'EOF' | cat > \"output file.txt\"\ntext\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["output file.txt"])
		})

		it("detects tab-indented heredoc cat <<-EOF > Makefile", () => {
			const command = "cat <<-EOF > Makefile\n\tall:\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["Makefile"])
		})

		it("detects delimiters with hyphens: cat << 'EOF-1' > file.txt", () => {
			const command = "cat << 'EOF-1' > file.txt\nhello\nEOF-1"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, true)
			assert.deepEqual(result.targetFiles, ["file.txt"])
		})

		it("does not flag heredoc without file redirection (e.g. python3 << 'EOF')", () => {
			const command = "python3 << 'EOF'\nimport sys\nprint(sys.version)\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, false)
			assert.deepEqual(result.targetFiles, [])
		})

		it("does not flag /dev/null redirection as a workspace file write", () => {
			const command = "cat << 'EOF' > /dev/null\ntest\nEOF"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, false)
			assert.deepEqual(result.targetFiles, [])
		})

		it("does not flag normal shell commands", () => {
			assert.equal(detectHeredocFileRedirection("npm test").isHeredocFileWrite, false)
			assert.equal(detectHeredocFileRedirection("git status").isHeredocFileWrite, false)
			assert.equal(detectHeredocFileRedirection("echo 'Hello world'").isHeredocFileWrite, false)
		})

		it("does not flag bitwise shift expressions", () => {
			const command = "echo $((1 << 4))"
			const result = detectHeredocFileRedirection(command)
			assert.equal(result.isHeredocFileWrite, false)
		})

		it("handles empty and non-string inputs safely", () => {
			assert.equal(detectHeredocFileRedirection("").isHeredocFileWrite, false)
			assert.equal(detectHeredocFileRedirection(null as any).isHeredocFileWrite, false)
			assert.equal(detectHeredocFileRedirection(undefined as any).isHeredocFileWrite, false)
		})
	})

	describe("findTopLevelHeredocs", () => {
		it("finds top-level heredocs while skipping arithmetic bitwise shifts", () => {
			const command = "echo $((1 << bit)); gcc -x c - << 'EOF'\n#include <stdio.h>\nint main(){}\nEOF"
			const heredocs = findTopLevelHeredocs(command)
			assert.equal(heredocs.length, 1)
			assert.equal(heredocs[0].delimiter, "EOF")
		})

		it("ignores << inside double or single quotes", () => {
			assert.deepEqual(findTopLevelHeredocs('git commit -m "feat: <<EOF\nEOF\n"'), [])
			assert.deepEqual(findTopLevelHeredocs("git commit -m 'feat: <<component>> update\n\nDetails'"), [])
		})
	})

	describe("isMultilineHeredocCommand", () => {
		it("detects multiline heredoc commands", () => {
			const command = "cat > game.c <<'EOF'\n#include <stdio.h>\nEOF"
			assert.equal(isMultilineHeredocCommand(command), true)
		})

		it("detects multiline interpreter heredocs without file redirection", () => {
			const command = "python3 << 'EOF'\nprint('hello')\nEOF"
			assert.equal(isMultilineHeredocCommand(command), true)
		})

		it("detects multiline heredocs after bitwise arithmetic shifts with variable names", () => {
			const command = "echo $((1 << bit))\ngcc -x c - << 'EOF'\n#include <stdio.h>\nint main(){}\nEOF"
			assert.equal(isMultilineHeredocCommand(command), true)
		})

		it("detects arbitrary tools running heredocs (node, bun, sqlite3)", () => {
			assert.equal(isMultilineHeredocCommand("node << 'EOF'\nconsole.log(1)\nEOF"), true)
			assert.equal(isMultilineHeredocCommand("sqlite3 db.sqlite << 'EOF'\nSELECT 1;\nEOF"), true)
		})

		it("detects unclosed multiline heredocs to prevent hanging shell integration", () => {
			assert.equal(isMultilineHeredocCommand("cat << 'EOF'\nline 1\nline 2"), true)
		})

		it("returns false for single-line commands without heredoc", () => {
			assert.equal(isMultilineHeredocCommand("echo $((1 << 4))"), false)
			assert.equal(isMultilineHeredocCommand("npm run build"), false)
			assert.equal(isMultilineHeredocCommand("git commit -m 'feat: update'"), false)
		})

		it("returns false for multiline commands that do not use heredoc", () => {
			const command = "echo 'line 1'\necho 'line 2'\nnpm test"
			assert.equal(isMultilineHeredocCommand(command), false)
		})

		it("returns false for multiline commit message with << notation inside quotes", () => {
			assert.equal(isMultilineHeredocCommand("git commit -m 'feat: <<component>> update\n\nDetailed description'"), false)
			assert.equal(isMultilineHeredocCommand('git commit -m "feat: <<EOF\nEOF\n"'), false)
		})
	})
})
