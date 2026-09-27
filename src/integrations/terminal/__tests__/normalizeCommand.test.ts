import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { describe, it } from "mocha"
import { normalizeShellCommand } from "../normalizeCommand"

describe("shell command normalization", () => {
	const cases = [
		["node --version &amp;&amp; npm --version", "node --version && npm --version"],
		["first&amp;&amp;second", "first&&second"],
		["first &amp;& second &amp;", "first && second &"],
		["run &gt;out 2&gt;&amp;1 &lt;in", "run >out 2>&1 <in"],
		["first &amp;amp;&amp;amp; second &amp;gt; out", "first && second > out"],
		["printf '%s' '&amp;&amp; &lt;tag&gt; &quot; &apos;'", "printf '%s' '&amp;&amp; &lt;tag&gt; &quot; &apos;'"],
		['echo "&amp;&amp;" &amp;&amp; echo done', 'echo "&amp;&amp;" && echo done'],
		['echo "a\\"&amp;b" &amp;&amp; echo done', 'echo "a\\"&amp;b" && echo done'],
		["echo 'a\\' &amp;&amp; echo done", "echo 'a\\' && echo done"],
		["echo \\&amp; &amp;&amp; echo done", "echo \\&amp; && echo done"],
		["echo `printf '&amp;'` &amp;&amp; echo done", "echo `printf '&amp;'` && echo done"],
		['echo "$(printf "%s" "&amp;")" &amp;&amp; echo done', 'echo "$(printf "%s" "&amp;")" && echo done'],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell parameter expansions must remain literal test input.
		['echo "${value:-"&amp;"}" &amp;&amp; echo done', 'echo "${value:-"&amp;"}" && echo done'],
		['echo "$(echo "$(printf "%s" "&amp;")")" &amp;&amp; echo done', 'echo "$(echo "$(printf "%s" "&amp;")")" && echo done'],
		[
			"# &amp; is literal\necho yes &amp;&amp; echo no # &lt;html&gt;",
			"# &amp; is literal\necho yes && echo no # &lt;html&gt;",
		],
		[
			"cat <<'EOF'\n&amp; &lt; &gt; &quot;\nEOF\necho x &amp;&amp; echo y",
			"cat <<'EOF'\n&amp; &lt; &gt; &quot;\nEOF\necho x && echo y",
		],
		["cat &lt;&lt; EOF\n&amp;&amp;\nEOF\necho x &amp;&amp; echo y", "cat << EOF\n&amp;&amp;\nEOF\necho x && echo y"],
		["cat <<-\\EOF\n\t&amp;\n\tEOF\necho x &amp;&amp; echo y", "cat <<-\\EOF\n\t&amp;\n\tEOF\necho x && echo y"],
		[
			"cat <<FIRST <<'SECOND'\n&amp;\nFIRST\n&lt;\nSECOND\necho x &amp;&amp; echo y",
			"cat <<FIRST <<'SECOND'\n&amp;\nFIRST\n&lt;\nSECOND\necho x && echo y",
		],
		["cat <<E'OF'\n&amp;\nEOF\necho x &amp;&amp; echo y", "cat <<E'OF'\n&amp;\nEOF\necho x && echo y"],
		["cat <<EOF\n&amp; without a delimiter", "cat <<EOF\n&amp; without a delimiter"],
		["cat <<< '&amp;'\necho x &amp;&amp; echo y", "cat <<< '&amp;'\necho x && echo y"],
		[
			"node '/path with spaces/concept-seed.mjs' --scope direction --mode operate",
			"node '/path with spaces/concept-seed.mjs' --scope direction --mode operate",
		],
		["node script.mjs --mode opera", "node script.mjs --mode opera"],
		["", ""],
	]
	for (const [input, expected] of cases) {
		it(`preserves command semantics: ${JSON.stringify(input)}`, () => {
			assert.equal(normalizeShellCommand(input), expected)
			assert.equal(normalizeShellCommand(expected), expected, "normalization must be idempotent")
		})
	}

	it("executes repaired shell operators while retaining literal script output", () => {
		if (process.platform === "win32") return
		const command = "printf 'first\\n' &amp;&amp; cat <<'EOF'\n&amp;&amp; --mode operate\nEOF\nprintf 'last\\n'"
		const result = spawnSync("/bin/sh", ["-c", normalizeShellCommand(command)], { encoding: "utf8" })
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.stdout, "first\n&amp;&amp; --mode operate\nlast\n")
	})
	it("preserves literal output inside nested shell expansions", () => {
		if (process.platform === "win32") return
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell parameter expansion, not JavaScript interpolation.
		const command = 'printf "%s\\n" "$(printf "%s" "&amp;")" &amp;&amp; printf "%s\\n" "${missing:-"&lt;"}"'
		const result = spawnSync("/bin/sh", ["-c", normalizeShellCommand(command)], { encoding: "utf8", env: {} })
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.stdout, "&amp;\n&lt;\n")
	})
})
