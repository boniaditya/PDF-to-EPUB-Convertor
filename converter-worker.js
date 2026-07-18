import * as pdfjsLib from "./libs/pdf.min.mjs";
import {
  buildFixedLayoutEpub,
  buildReflowableEpub,
  textItemsToParagraphs
} from "./src/epub-builder.js";
import {
  parsePageRange,
  recommendedRenderWorkerCount,
  safeRenderScaleForViewport
} from "./src/conversion-options.js";

pdfjsLib.setVerbosityLevel?.(pdfjsLib.VerbosityLevel?.ERRORS ?? 0);

self.addEventListener("message", (event) => {
  if (event.data?.type !== "convert") {
    return;
  }

  convert(event.data.id, event.data.payload).catch((error) => {
    postMessage({
      type: "error",
      id: event.data.id,
      error: serializeError(error)
    });
  });
});

async function convert(id, payload) {
  let pdf;

  try {
    postProgress(id, "Opening PDF...", 0, 1);
    const sourceFile = payload.sourceFile || payload.sourceBuffer;
    pdf = await openPdf(sourceFile, payload.runtimeUrls);

    const pageNumbers = parsePageRange(payload.pageRange || "", pdf.numPages);
    const result =
      payload.epubType === "fixed"
        ? await createFixedLayout(
            id,
            pdf,
            payload.metadata,
            pageNumbers,
            payload.scale,
            sourceFile,
            payload.runtimeUrls,
            payload.performance
          )
        : await createReflowable(id, pdf, payload.metadata, pageNumbers);

    postProgress(id, "Preparing download...", pageNumbers.length, pageNumbers.length);
    postMessage({
      type: "complete",
      id,
      blob: result.blob,
      warning: result.warning || "",
      pageCount: pdf.numPages,
      convertedPages: pageNumbers.length
    });
  } finally {
    if (pdf?.destroy) {
      await Promise.resolve(pdf.destroy()).catch(() => {});
    }
  }
}

async function openPdf(sourceFile, runtimeUrls) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = runtimeUrls.workerSrc;
  const sourceBuffer = sourceFile instanceof Blob ? await sourceFile.arrayBuffer() : sourceFile;

  return pdfjsLib.getDocument({
    data: new Uint8Array(sourceBuffer),
    cMapUrl: runtimeUrls.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: runtimeUrls.standardFontDataUrl,
    wasmUrl: runtimeUrls.wasmUrl,
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: NoopFilterFactory,
    useWorkerFetch: true,
    isEvalSupported: false,
    stopAtErrors: false
  }).promise;
}

async function createReflowable(id, pdf, metadata, pageNumbers) {
  const pages = [];
  let extractedCharacters = 0;

  for (const [index, pageNumber] of pageNumbers.entries()) {
    postProgress(id, `Extracting page ${pageNumber} (${index + 1} of ${pageNumbers.length})...`, index, pageNumbers.length);

    let page;
    try {
      page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const paragraphs = textItemsToParagraphs(textContent.items);
      extractedCharacters += paragraphs.join("").length;
      pages.push({ number: pageNumber, paragraphs });
    } catch (error) {
      console.warn(`Could not extract text from page ${pageNumber}.`, error);
      pages.push({
        number: pageNumber,
        paragraphs: [`Page ${pageNumber} could not be extracted as text.`]
      });
    } finally {
      page?.cleanup();
    }
  }

  postProgress(id, "Packaging EPUB...", pageNumbers.length, pageNumbers.length);

  const averageCharacters = extractedCharacters / Math.max(1, pages.length);
  const warning =
    averageCharacters < 80
      ? "EPUB saved, but this PDF has weak text extraction. Fixed layout should preserve it better."
      : "";

  return {
    blob: buildReflowableEpub({ metadata, pages }),
    warning
  };
}

async function createFixedLayout(
  id,
  pdf,
  metadata,
  pageNumbers,
  scale,
  sourceFile,
  runtimeUrls,
  performance = {}
) {
  if (!("OffscreenCanvas" in self)) {
    throw new Error("Fixed-layout conversion needs OffscreenCanvas. Please use a current Chrome version.");
  }

  const workerCount = recommendedRenderWorkerCount(
    pageNumbers.length,
    performance.hardwareConcurrency,
    performance.deviceMemory
  );
  let pages;

  if (workerCount > 1 && typeof Worker === "function" && runtimeUrls.pageWorkerSrc) {
    postProgress(
      id,
      `Starting ${workerCount} parallel page renderers...`,
      0,
      pageNumbers.length
    );

    try {
      pages = await renderFixedPagesInPool(
        id,
        pageNumbers,
        scale,
        sourceFile,
        runtimeUrls,
        workerCount
      );
    } catch (error) {
      if (!error?.canFallback) {
        throw error;
      }

      console.warn("Parallel rendering was unavailable; using the coordinator worker.", error);
      postProgress(
        id,
        "Parallel rendering unavailable. Continuing with one renderer...",
        0,
        pageNumbers.length
      );
      pages = await renderFixedPagesSequentially(id, pdf, pageNumbers, scale);
    }
  } else {
    pages = await renderFixedPagesSequentially(id, pdf, pageNumbers, scale);
  }

  postProgress(id, "Packaging fixed-layout EPUB...", pageNumbers.length, pageNumbers.length);

  return {
    blob: buildFixedLayoutEpub({ metadata, pages })
  };
}

async function renderFixedPagesSequentially(id, pdf, pageNumbers, scale) {
  const pages = [];
  const requestedScale = Number(scale || 1);

  for (const [index, pageNumber] of pageNumbers.entries()) {
    postProgress(id, `Rendering page ${pageNumber} (${index + 1} of ${pageNumbers.length})...`, index, pageNumbers.length);

    const page = await pdf.getPage(pageNumber);

    try {
      const baseViewport = page.getViewport({ scale: 1 });
      const safeScale = safeRenderScaleForViewport(baseViewport.width, baseViewport.height, requestedScale);
      const viewport = page.getViewport({ scale: safeScale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { alpha: false });

      if (!context) {
        throw new Error("Could not create a page rendering canvas.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);

      await page.render({
        canvasContext: context,
        viewport,
        canvasFactory: new OffscreenCanvasFactory()
      }).promise;

      const imageBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      const imageBytes = new Uint8Array(await imageBlob.arrayBuffer());

      pages.push({
        number: pageNumber,
        width,
        height,
        imageName: `page-${String(pageNumber).padStart(3, "0")}.jpg`,
        imageBytes,
        mediaType: "image/jpeg"
      });
    } finally {
      page.cleanup();
    }
  }

  return pages;
}

function renderFixedPagesInPool(id, pageNumbers, scale, sourceFile, runtimeUrls, workerCount) {
  return new Promise((resolve, reject) => {
    const queue = [...pageNumbers];
    const pagesByNumber = new Map();
    const workers = [];
    let completed = 0;
    let settled = false;

    const stopWorkers = () => {
      for (const worker of workers) {
        worker.terminate();
      }
    };

    const fail = (error, canFallback = false) => {
      if (settled) {
        return;
      }

      settled = true;
      stopWorkers();
      error.canFallback = canFallback;
      reject(error);
    };

    const assignPage = (worker) => {
      const pageNumber = queue.shift();
      if (pageNumber === undefined) {
        return;
      }

      worker.postMessage({ type: "render", pageNumber });
    };

    const handleMessage = (worker, event) => {
      if (settled) {
        return;
      }

      const message = event.data;
      if (message?.type === "ready") {
        assignPage(worker);
        return;
      }

      if (message?.type === "error") {
        const error = new Error(message.error?.message || "A page renderer failed.");
        error.name = message.error?.name || "Error";
        error.stack = message.error?.stack || error.stack;
        fail(error, message.phase === "initialize");
        return;
      }

      if (message?.type !== "page") {
        return;
      }

      const page = message.page;
      pagesByNumber.set(page.number, {
        number: page.number,
        width: page.width,
        height: page.height,
        imageName: page.imageName,
        imageBytes: new Uint8Array(page.imageBuffer),
        mediaType: page.mediaType
      });
      completed += 1;

      postProgress(
        id,
        `Rendered page ${page.number} (${completed} of ${pageNumbers.length}) with ${workerCount} workers...`,
        completed,
        pageNumbers.length
      );

      if (completed === pageNumbers.length) {
        settled = true;
        stopWorkers();
        resolve(pageNumbers.map((pageNumber) => pagesByNumber.get(pageNumber)));
        return;
      }

      assignPage(worker);
    };

    try {
      for (let index = 0; index < workerCount; index += 1) {
        const worker = new Worker(runtimeUrls.pageWorkerSrc, {
          type: "module",
          name: `pdf-page-renderer-${index + 1}`
        });
        workers.push(worker);
        worker.addEventListener("message", (event) => handleMessage(worker, event));
        worker.addEventListener("error", (event) => {
          fail(new Error(event.message || "A parallel page renderer could not start."), true);
        });
        worker.postMessage({
          type: "initialize",
          sourceFile,
          runtimeUrls,
          scale
        });
      }
    } catch (error) {
      fail(error, true);
    }
  });
}

function postProgress(id, message, value, max) {
  postMessage({
    type: "progress",
    id,
    message,
    value,
    max
  });
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "Conversion failed.",
    stack: error?.stack || ""
  };
}

class OffscreenCanvasFactory {
  create(width, height) {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size.");
    }

    const canvas = new OffscreenCanvas(width, height);
    // PDF.js uses factory canvases for transparency masks, so alpha must stay enabled.
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not create an offscreen canvas context.");
    }

    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size.");
    }

    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

class NoopFilterFactory {
  addFilter() {
    return "none";
  }

  addHCMFilter() {
    return "none";
  }

  addAlphaFilter() {
    return "none";
  }

  addLuminosityFilter() {
    return "none";
  }

  addHighlightHCMFilter() {
    return "none";
  }

  destroy() {}
}
