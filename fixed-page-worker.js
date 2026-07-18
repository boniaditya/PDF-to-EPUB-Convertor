import * as pdfjsLib from "./libs/pdf.min.mjs";
import { safeRenderScaleForViewport } from "./src/conversion-options.js";

pdfjsLib.setVerbosityLevel?.(pdfjsLib.VerbosityLevel?.ERRORS ?? 0);

let pdf;
let requestedScale = 1;

self.addEventListener("message", (event) => {
  const message = event.data;

  if (message?.type === "initialize") {
    initialize(message).catch((error) => {
      postMessage({ type: "error", phase: "initialize", error: serializeError(error) });
    });
    return;
  }

  if (message?.type === "render") {
    renderPage(message.pageNumber).catch((error) => {
      postMessage({
        type: "error",
        phase: "render",
        pageNumber: message.pageNumber,
        error: serializeError(error)
      });
    });
  }
});

async function initialize({ sourceFile, runtimeUrls, scale }) {
  requestedScale = Number(scale || 1);
  pdf = await openPdf(sourceFile, runtimeUrls);
  postMessage({ type: "ready" });
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

async function renderPage(pageNumber) {
  if (!pdf) {
    throw new Error("The page renderer is not initialized.");
  }

  const page = await pdf.getPage(pageNumber);
  let canvas;

  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const safeScale = safeRenderScaleForViewport(
      baseViewport.width,
      baseViewport.height,
      requestedScale
    );
    const viewport = page.getViewport({ scale: safeScale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    canvas = new OffscreenCanvas(width, height);
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
    const imageBuffer = await imageBlob.arrayBuffer();

    postMessage(
      {
        type: "page",
        page: {
          number: pageNumber,
          width,
          height,
          imageName: `page-${String(pageNumber).padStart(3, "0")}.jpg`,
          imageBuffer,
          mediaType: "image/jpeg"
        }
      },
      [imageBuffer]
    );
  } finally {
    page.cleanup();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "Page rendering failed.",
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
