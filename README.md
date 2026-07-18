# Offline PDF to EPUB Converter

A Manifest V3 Chrome extension that converts local PDFs into EPUB files without sending files to a server.

## What it creates

- Reflowable EPUB: extracts PDF text and packages it as EPUB 3 XHTML pages for e-readers.
- Fixed-layout EPUB: renders each PDF page to an image and packages those pages as EPUB 3 fixed layout.
- Parallel rendering: long fixed-layout jobs automatically use up to four page workers, adjusted for available CPU and memory.
- Page ranges: convert all pages or ranges like `1-20, 35`.

## Install in Chrome

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder: `/Users/Aditya/Documents/PDF to EPUB Convertor`.

The extension asks for no host permissions, uses the Downloads permission to save the EPUB, and loads only bundled files from `libs/`.

For long PDFs, click Open in tab from the popup before converting. Chrome popups can close during long-running work, while a full tab is more reliable.

## Project layout

```text
.
├── manifest.json
├── popup.html
├── popup.js
├── converter-worker.js
├── fixed-page-worker.js
├── styles.css
├── libs/
│   ├── pdf.min.mjs
│   ├── pdf.worker.min.mjs
│   ├── pdfjs-LICENSE
│   ├── cmaps/
│   ├── standard_fonts/
│   └── wasm/
├── src/
│   ├── conversion-options.js
│   └── epub-builder.js
└── test/
    ├── conversion-options.test.mjs
    └── epub-builder.test.mjs
```

## Notes

Reflowable conversion depends on extractable PDF text, so scanned image-only PDFs need OCR before they can become useful reflowable EPUBs. Internet Archive scans often have weak OCR text layers; use fixed layout for those books when visual fidelity matters. Fixed-layout conversion preserves the visual page more faithfully, but it produces larger EPUB files and does not provide selectable text.

## Test

```bash
npm test
```
