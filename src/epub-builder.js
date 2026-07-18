const XHTML_NS = "http://www.w3.org/1999/xhtml";
const OPF_NS = "http://www.idpf.org/2007/opf";
const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";
const XHTML_DOCTYPE = "<!DOCTYPE html>";
const textEncoder = new TextEncoder();

let crcTable;

function makeCrcTable() {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }

  return table;
}

function crc32(bytes) {
  crcTable ||= makeCrcTable();

  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function uint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function concatBytes(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function toBytes(data) {
  if (typeof data === "string") {
    return textEncoder.encode(data);
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  throw new TypeError("EPUB file data must be a string, Uint8Array, or ArrayBuffer.");
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosDate, dosTime };
}

function createStoredZipParts(files, date = new Date()) {
  const localParts = [];
  const centralParts = [];
  const { dosDate, dosTime } = dosDateTime(date);
  let offset = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.path);
    const dataBytes = toBytes(file.data);
    const checksum = crc32(dataBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);

    uint32(localView, 0, 0x04034b50);
    uint16(localView, 4, 20);
    uint16(localView, 6, 0x0800);
    uint16(localView, 8, 0);
    uint16(localView, 10, dosTime);
    uint16(localView, 12, dosDate);
    uint32(localView, 14, checksum);
    uint32(localView, 18, dataBytes.length);
    uint32(localView, 22, dataBytes.length);
    uint16(localView, 26, nameBytes.length);
    uint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);

    uint32(centralView, 0, 0x02014b50);
    uint16(centralView, 4, 20);
    uint16(centralView, 6, 20);
    uint16(centralView, 8, 0x0800);
    uint16(centralView, 10, 0);
    uint16(centralView, 12, dosTime);
    uint16(centralView, 14, dosDate);
    uint32(centralView, 16, checksum);
    uint32(centralView, 20, dataBytes.length);
    uint32(centralView, 24, dataBytes.length);
    uint16(centralView, 28, nameBytes.length);
    uint16(centralView, 30, 0);
    uint16(centralView, 32, 0);
    uint16(centralView, 34, 0);
    uint16(centralView, 36, 0);
    uint32(centralView, 38, 0);
    uint32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, dataBytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryLength = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);

  uint32(endView, 0, 0x06054b50);
  uint16(endView, 4, 0);
  uint16(endView, 6, 0);
  uint16(endView, 8, files.length);
  uint16(endView, 10, files.length);
  uint32(endView, 12, centralDirectoryLength);
  uint32(endView, 16, centralDirectoryOffset);
  uint16(endView, 20, 0);

  return [...localParts, ...centralParts, endRecord];
}

export function createStoredZip(files, date = new Date()) {
  return concatBytes(createStoredZipParts(files, date));
}

export function createStoredZipBlob(files, date = new Date(), type = "application/zip") {
  return new Blob(createStoredZipParts(files, date), { type });
}

export function createEpubBlob(files) {
  return createStoredZipBlob(files, new Date(), "application/epub+zip");
}

export function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fileBaseName(fileName = "converted-book") {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  return withoutExtension.trim() || "converted-book";
}

export function downloadName(fileName, epubType) {
  const suffix = epubType === "fixed" ? "fixed-layout" : "reflowable";
  return `${fileBaseName(fileName).replace(/[\\/:*?"<>|]+/g, "-")}-${suffix}.epub`;
}

export function bookId() {
  if (globalThis.crypto?.randomUUID) {
    return `urn:uuid:${globalThis.crypto.randomUUID()}`;
  }

  return `urn:uuid:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function textItemsToParagraphs(items) {
  const positionedItems = items
    .filter((item) => item?.str?.trim())
    .map((item) => {
      const transform = item.transform || [1, 0, 0, 1, 0, 0];
      return {
        text: item.str.replace(/\s+/g, " ").trim(),
        x: Number(transform[4] || 0),
        y: Number(transform[5] || 0),
        height: Math.abs(Number(transform[3] || item.height || 10))
      };
    })
    .sort((a, b) => {
      const yDiff = b.y - a.y;
      return Math.abs(yDiff) > 2 ? yDiff : a.x - b.x;
    });

  if (!positionedItems.length) {
    return [];
  }

  const lines = [];
  for (const item of positionedItems) {
    const previous = lines[lines.length - 1];
    const tolerance = Math.max(2, item.height * 0.45);

    if (previous && Math.abs(previous.y - item.y) <= tolerance) {
      previous.items.push(item);
      previous.y = (previous.y + item.y) / 2;
      previous.height = Math.max(previous.height, item.height);
    } else {
      lines.push({ y: item.y, height: item.height, items: [item] });
    }
  }

  const lineTexts = lines.map((line) => {
    const sorted = [...line.items].sort((a, b) => a.x - b.x);
    return {
      y: line.y,
      height: line.height,
      text: sorted.reduce((lineText, item) => joinText(lineText, item.text), "")
    };
  });

  const paragraphs = [];
  let current = [];
  let previousLine;

  for (const line of lineTexts) {
    const gap = previousLine ? previousLine.y - line.y : 0;
    const newParagraph = previousLine && gap > Math.max(14, previousLine.height * 1.75);

    if (newParagraph && current.length) {
      paragraphs.push(current.join(" "));
      current = [];
    }

    current.push(line.text);
    previousLine = line;
  }

  if (current.length) {
    paragraphs.push(current.join(" "));
  }

  return paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
}

function joinText(current, next) {
  if (!current) {
    return next;
  }

  if (/^[,.;:!?%)]/.test(next) || /[(]$/.test(current)) {
    return `${current}${next}`;
  }

  return `${current} ${next}`;
}

function baseFiles() {
  return [
    { path: "mimetype", data: "application/epub+zip" },
    {
      path: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="${CONTAINER_NS}">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    }
  ];
}

function cleanMetadata(metadata) {
  return {
    identifier: metadata.identifier || bookId(),
    title: metadata.title?.trim() || "Converted PDF",
    author: metadata.author?.trim() || "Unknown",
    language: metadata.language?.trim() || "en",
    modified: metadata.modified || new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  };
}

function packageOpf({ metadata, layout, manifestItems, spineItems }) {
  const renditionMeta =
    layout === "fixed"
      ? `<meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">auto</meta>`
      : `<meta property="rendition:layout">reflowable</meta>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="${OPF_NS}" version="3.0" unique-identifier="bookid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(metadata.identifier)}</dc:identifier>
    <dc:title>${escapeXml(metadata.title)}</dc:title>
    <dc:creator>${escapeXml(metadata.author)}</dc:creator>
    <dc:language>${escapeXml(metadata.language)}</dc:language>
    <meta property="dcterms:modified">${escapeXml(metadata.modified)}</meta>
    ${renditionMeta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine>
    ${spineItems.join("\n    ")}
  </spine>
</package>`;
}

function navDocument(metadata, pages) {
  const links = pages
    .map((page) => `<li><a href="pages/page-${pad(page.number)}.xhtml">Page ${page.number}</a></li>`)
    .join("\n        ");

  return `<?xml version="1.0" encoding="utf-8"?>
${XHTML_DOCTYPE}
<html xmlns="${XHTML_NS}" lang="${escapeXml(metadata.language)}">
  <head>
    <title>${escapeXml(metadata.title)}</title>
  </head>
  <body>
    <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
      <h1>${escapeXml(metadata.title)}</h1>
      <ol>
        ${links}
      </ol>
    </nav>
  </body>
</html>`;
}

function pad(number) {
  return String(number).padStart(3, "0");
}

function reflowableCss() {
  return `html {
  color: #171f1b;
  font-family: serif;
}

body {
  line-height: 1.5;
  margin: 0;
  padding: 1.25rem;
}

h1 {
  font-size: 1.4rem;
  line-height: 1.2;
  margin: 0 0 1rem;
}

p {
  margin: 0 0 0.85rem;
}`;
}

function fixedCss() {
  return `html,
body {
  background: white;
  margin: 0;
  padding: 0;
}

img {
  display: block;
  margin: 0;
  padding: 0;
}`;
}

function reflowablePage(metadata, page) {
  const paragraphs = page.paragraphs.length
    ? page.paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join("\n      ")
    : "<p>No extractable text was found on this page.</p>";

  return `<?xml version="1.0" encoding="utf-8"?>
${XHTML_DOCTYPE}
<html xmlns="${XHTML_NS}" lang="${escapeXml(metadata.language)}">
  <head>
    <title>Page ${page.number}</title>
    <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
  </head>
  <body>
    <section>
      <h1>Page ${page.number}</h1>
      ${paragraphs}
    </section>
  </body>
</html>`;
}

function fixedPage(metadata, page) {
  return `<?xml version="1.0" encoding="utf-8"?>
${XHTML_DOCTYPE}
<html xmlns="${XHTML_NS}" lang="${escapeXml(metadata.language)}">
  <head>
    <title>Page ${page.number}</title>
    <meta name="viewport" content="width=${page.width}, height=${page.height}"/>
    <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
  </head>
  <body style="width:${page.width}px;height:${page.height}px;">
    <img src="../images/${escapeXml(page.imageName)}" alt="Page ${page.number}" style="width:${page.width}px;height:${page.height}px;"/>
  </body>
</html>`;
}

export function buildReflowableEpub({ metadata: rawMetadata, pages }) {
  const metadata = cleanMetadata(rawMetadata);
  const files = baseFiles();
  const manifestItems = [];
  const spineItems = [];

  files.push({ path: "OEBPS/styles/book.css", data: reflowableCss() });
  files.push({ path: "OEBPS/nav.xhtml", data: navDocument(metadata, pages) });

  for (const page of pages) {
    const id = `page-${pad(page.number)}`;
    files.push({
      path: `OEBPS/pages/${id}.xhtml`,
      data: reflowablePage(metadata, page)
    });
    manifestItems.push(`<item id="${id}" href="pages/${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${id}"/>`);
  }

  files.push({
    path: "OEBPS/package.opf",
    data: packageOpf({ metadata, layout: "reflowable", manifestItems, spineItems })
  });

  return createEpubBlob(files);
}

export function buildFixedLayoutEpub({ metadata: rawMetadata, pages }) {
  const metadata = cleanMetadata(rawMetadata);
  const files = baseFiles();
  const manifestItems = [];
  const spineItems = [];

  files.push({ path: "OEBPS/styles/book.css", data: fixedCss() });
  files.push({ path: "OEBPS/nav.xhtml", data: navDocument(metadata, pages) });

  for (const page of pages) {
    const id = `page-${pad(page.number)}`;
    const imageId = `image-${pad(page.number)}`;
    files.push({
      path: `OEBPS/images/${page.imageName}`,
      data: page.imageBytes
    });
    files.push({
      path: `OEBPS/pages/${id}.xhtml`,
      data: fixedPage(metadata, page)
    });
    manifestItems.push(`<item id="${id}" href="pages/${id}.xhtml" media-type="application/xhtml+xml"/>`);
    manifestItems.push(
      `<item id="${imageId}" href="images/${escapeXml(page.imageName)}" media-type="${escapeXml(page.mediaType)}"/>`
    );
    spineItems.push(`<itemref idref="${id}" properties="rendition:layout-pre-paginated"/>`);
  }

  files.push({
    path: "OEBPS/package.opf",
    data: packageOpf({ metadata, layout: "fixed", manifestItems, spineItems })
  });

  return createEpubBlob(files);
}
