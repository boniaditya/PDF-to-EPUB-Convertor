export function parsePageRange(value, pageCount) {
  const trimmed = value.trim();

  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("This PDF does not contain any pages.");
  }

  if (!trimmed || /^all$/i.test(trimmed)) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = new Set();
  for (const token of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(`Page range must look like 1-20, 35. This PDF has ${pageCount} pages.`);
    }

    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);

    if (start < 1 || end > pageCount || start > end) {
      throw new Error(`Page range must be between 1 and ${pageCount}.`);
    }

    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      pages.add(pageNumber);
    }
  }

  return [...pages].sort((a, b) => a - b);
}

export function safeRenderScaleForViewport(width, height, requestedScale, maxCanvasPixels = 16_000_000) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  const safeScale = Number(requestedScale) || 1;
  const basePixels = safeWidth * safeHeight;

  if (!Number.isFinite(basePixels) || basePixels <= 0) {
    return safeScale;
  }

  const requestedPixels = basePixels * safeScale * safeScale;

  if (requestedPixels <= maxCanvasPixels) {
    return safeScale;
  }

  return Math.sqrt(maxCanvasPixels / basePixels);
}

export function recommendedRenderWorkerCount(
  pageCount,
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency || 4,
  deviceMemory = globalThis.navigator?.deviceMemory || 8
) {
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  if (pages < 8) {
    return 1;
  }

  const cores = Math.max(1, Math.floor(Number(hardwareConcurrency) || 1));
  const memoryGb = Math.max(1, Number(deviceMemory) || 1);
  const cpuLimit = cores <= 2 ? 1 : Math.ceil(cores / 2);
  const memoryLimit = memoryGb <= 4 ? 2 : 4;

  return Math.max(1, Math.min(pages, 4, cpuLimit, memoryLimit));
}
