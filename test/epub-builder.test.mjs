import assert from "node:assert/strict";
import {
  buildFixedLayoutEpub,
  buildReflowableEpub,
  createStoredZip,
  createStoredZipBlob,
  textItemsToParagraphs
} from "../src/epub-builder.js";
import { spawnSync } from "node:child_process";

const decoder = new TextDecoder();

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function readZipEntries(bytes) {
  const entries = new Map();
  let offset = 0;

  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const signature = view.getUint32(0, true);

    if (signature !== 0x04034b50) {
      break;
    }

    const method = view.getUint16(8, true);
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataStart + size);

    entries.set(name, { method, data });
    offset = dataStart + size;
  }

  return entries;
}

function assertXmlParses(name, xml) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { readFileSync } from 'node:fs'; import { XMLParser } from './test/xml-smoke-parser.mjs'; const input = readFileSync(0, 'utf8'); new XMLParser(input).parseDocument();"
    ],
    {
      cwd: new URL("..", import.meta.url),
      input: xml,
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, `${name} should parse as XML: ${result.stderr || result.stdout}`);
}

{
  const zip = createStoredZip([
    { path: "mimetype", data: "application/epub+zip" },
    { path: "hello.txt", data: "Hello" }
  ]);
  const entries = readZipEntries(zip);

  assert.equal(decoder.decode(entries.get("mimetype").data), "application/epub+zip");
  assert.equal(entries.get("mimetype").method, 0);
  assert.equal(decoder.decode(entries.get("hello.txt").data), "Hello");
}

{
  const blob = createStoredZipBlob([{ path: "blob.txt", data: "Blob path" }]);
  const entries = readZipEntries(await blobBytes(blob));

  assert.equal(blob.type, "application/zip");
  assert.equal(decoder.decode(entries.get("blob.txt").data), "Blob path");
}

{
  const paragraphs = textItemsToParagraphs([
    { str: "Hello", transform: [1, 0, 0, 10, 10, 100] },
    { str: "world", transform: [1, 0, 0, 10, 45, 100] },
    { str: "Next", transform: [1, 0, 0, 10, 10, 70] },
    { str: "paragraph", transform: [1, 0, 0, 10, 45, 70] }
  ]);

  assert.deepEqual(paragraphs, ["Hello world", "Next paragraph"]);
}

{
  const blob = buildReflowableEpub({
    metadata: { title: "Sample", author: "Codex", language: "en", modified: "2026-07-18T00:00:00Z" },
    pages: [{ number: 1, paragraphs: ["One & two", "Three < four"] }]
  });
  const entries = readZipEntries(await blobBytes(blob));
  const opf = decoder.decode(entries.get("OEBPS/package.opf").data);
  const page = decoder.decode(entries.get("OEBPS/pages/page-001.xhtml").data);

  assert.match(opf, /rendition:layout">reflowable/);
  assert.match(page, /<\!DOCTYPE html>/);
  assert.doesNotMatch(page, /<\!doctype html>/);
  assert.match(page, /One &amp; two/);
  assert.match(page, /Three &lt; four/);
  assertXmlParses("reflowable page", page);
  assertXmlParses("reflowable nav", decoder.decode(entries.get("OEBPS/nav.xhtml").data));
}

{
  const blob = buildFixedLayoutEpub({
    metadata: { title: "Fixed", author: "Codex", language: "en", modified: "2026-07-18T00:00:00Z" },
    pages: [
      {
        number: 1,
        width: 600,
        height: 800,
        imageName: "page-001.jpg",
        imageBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        mediaType: "image/jpeg"
      }
    ]
  });
  const entries = readZipEntries(await blobBytes(blob));
  const opf = decoder.decode(entries.get("OEBPS/package.opf").data);
  const page = decoder.decode(entries.get("OEBPS/pages/page-001.xhtml").data);

  assert.match(opf, /rendition:layout">pre-paginated/);
  assert.match(opf, /images\/page-001\.jpg/);
  assert.match(page, /<\!DOCTYPE html>/);
  assert.doesNotMatch(page, /<\!doctype html>/);
  assert.match(page, /width=600, height=800/);
  assertXmlParses("fixed-layout page", page);
  assertXmlParses("fixed-layout nav", decoder.decode(entries.get("OEBPS/nav.xhtml").data));
}

console.log("epub-builder tests passed");
