const NAME_START = /[:A-Z_a-z]/;
const NAME_CHAR = /[-.:A-Z_a-z0-9]/;

export class XMLParser {
  constructor(input) {
    this.input = input;
    this.offset = 0;
    this.stack = [];
  }

  parseDocument() {
    while (!this.done()) {
      if (this.peek("<?")) {
        this.consumeUntil("?>");
      } else if (this.peek("<!--")) {
        this.consumeUntil("-->");
      } else if (this.peek("<!DOCTYPE")) {
        this.consumeUntil(">");
      } else if (this.peek("</")) {
        this.parseEndTag();
      } else if (this.peek("<")) {
        this.parseStartTag();
      } else {
        this.offset += 1;
      }
    }

    if (this.stack.length) {
      throw new Error(`Unclosed tag ${this.stack.at(-1)}`);
    }
  }

  parseStartTag() {
    this.expect("<");
    const name = this.readName();
    let quote = "";
    let selfClosing = false;

    while (!this.done()) {
      const char = this.input[this.offset];
      const next = this.input[this.offset + 1];

      if (quote) {
        if (char === quote) {
          quote = "";
        }
        this.offset += 1;
      } else if (char === "\"" || char === "'") {
        quote = char;
        this.offset += 1;
      } else if (char === "/" && next === ">") {
        selfClosing = true;
        this.offset += 2;
        break;
      } else if (char === ">") {
        this.offset += 1;
        break;
      } else {
        this.offset += 1;
      }
    }

    if (!selfClosing) {
      this.stack.push(name);
    }
  }

  parseEndTag() {
    this.expect("</");
    const name = this.readName();
    this.consumeUntil(">");

    const open = this.stack.pop();
    if (open !== name) {
      throw new Error(`Expected closing tag for ${open}, got ${name}`);
    }
  }

  readName() {
    const first = this.input[this.offset];
    if (!NAME_START.test(first)) {
      throw new Error(`Invalid element name at offset ${this.offset}`);
    }

    let name = first;
    this.offset += 1;

    while (!this.done() && NAME_CHAR.test(this.input[this.offset])) {
      name += this.input[this.offset];
      this.offset += 1;
    }

    return name;
  }

  consumeUntil(token) {
    const nextOffset = this.input.indexOf(token, this.offset);
    if (nextOffset === -1) {
      throw new Error(`Missing ${token}`);
    }
    this.offset = nextOffset + token.length;
  }

  expect(token) {
    if (!this.peek(token)) {
      throw new Error(`Expected ${token} at offset ${this.offset}`);
    }
    this.offset += token.length;
  }

  peek(token) {
    return this.input.startsWith(token, this.offset);
  }

  done() {
    return this.offset >= this.input.length;
  }
}
