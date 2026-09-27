/** Streaming escape removal. Never guesses which printable text is an echo, prompt, or signal. */
export class TerminalOutputDecoder {
	private state: "text" | "escape" | "csi" | "string" | "stringEscape" | "charset" = "text"

	write(chunk: string): string {
		let output = ""
		for (const char of chunk) {
			switch (this.state) {
				case "text":
					if (char === "\x1b") this.state = "escape"
					else if (char === "\x9b") this.state = "csi"
					else if (char === "\x9d" || char === "\x90" || char === "\x9f" || char === "\x9e") this.state = "string"
					else if (char !== "\x07" && char !== "\x9c") output += char
					break
				case "escape":
					if (char === "[") this.state = "csi"
					else if ("]PX^_".includes(char)) this.state = "string"
					else if ("()*+-./".includes(char)) this.state = "charset"
					else {
						this.state = "text"
						if (!/[\x30-\x7e]/.test(char)) output += char
					}
					break
				case "csi":
					if (/[\x40-\x7e]/.test(char)) this.state = "text"
					else if (char === "\x1b") this.state = "escape"
					break
				case "string":
					if (char === "\x07" || char === "\x9c") this.state = "text"
					else if (char === "\x1b") this.state = "stringEscape"
					break
				case "stringEscape":
					if (char === "\\" || char === "\x07" || char === "\x9c") this.state = "text"
					else if (char !== "\x1b") this.state = "string"
					break
				case "charset":
					this.state = "text"
					break
			}
		}
		return output
	}
}
