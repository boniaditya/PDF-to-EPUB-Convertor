import { downloadName, fileBaseName } from "./src/epub-builder.js";

const form = document.getElementById("converterForm");
const pdfInput = document.getElementById("pdfInput");
const titleInput = document.getElementById("titleInput");
const authorInput = document.getElementById("authorInput");
const languageInput = document.getElementById("languageInput");
const pageRangeInput = document.getElementById("pageRangeInput");
const fixedOptions = document.getElementById("fixedOptions");
const scaleInput = document.getElementById("scaleInput");
const convertButton = document.getElementById("convertButton");
const openTabButton = document.getElementById("openTabButton");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const status = document.getElementById("status");
const fileName = document.getElementById("fileName");
const runState = document.getElementById("runState");
const runFile = document.getElementById("runFile");
const runLayout = document.getElementById("runLayout");
const runPages = document.getElementById("runPages");
const runStatus = document.getElementById("runStatus");

let activeWorker = null;
let activeJobId = 0;
const CONVERSION_WORKER_URL = "converter-worker.js?v=2026-07-18-5";
const PAGE_WORKER_URL = "fixed-page-worker.js?v=2026-07-18-5";

syncLayout();
syncRunSummary();
window.addEventListener("resize", syncLayout);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && activeWorker) {
    setStatus("Conversion is running in the background worker.");
  }
});
window.addEventListener("beforeunload", (event) => {
  if (!activeWorker) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
});

openTabButton.addEventListener("click", () => {
  window.open(getRuntimeUrl("popup.html?mode=tab"), "_blank", "noopener");
});

pdfInput.addEventListener("change", () => {
  const file = selectedPdf();
  fileName.textContent = file ? file.name : "Choose a PDF";
  runFile.textContent = file ? file.name : "None";

  if (file && !titleInput.value.trim()) {
    titleInput.value = fileBaseName(file.name);
  }
});

pageRangeInput.addEventListener("input", syncRunSummary);
scaleInput.addEventListener("change", syncRunSummary);

document.querySelectorAll('input[name="epubType"]').forEach((input) => {
  input.addEventListener("change", () => {
    fixedOptions.hidden = epubType() !== "fixed";
    syncRunSummary();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = selectedPdf();
  if (!file) {
    setStatus("Choose a PDF first.", "warn");
    runState.textContent = "Waiting";
    runStatus.textContent = "No PDF selected";
    return;
  }

  const type = epubType();
  const jobId = (activeJobId += 1);
  const metadata = {
    title: titleInput.value.trim() || fileBaseName(file.name),
    author: authorInput.value.trim() || "Unknown",
    language: languageInput.value.trim() || "en"
  };

  setBusy(true);
  setProgress(0, 1);
  setStatus("Opening PDF...");
  runState.textContent = "Running";
  runFile.textContent = file.name;
  syncRunSummary();

  try {
    const worker = createConversionWorker();
    activeWorker = worker;

    worker.addEventListener("message", async (messageEvent) => {
      const message = messageEvent.data;
      if (message?.id !== jobId) {
        return;
      }

      if (message.type === "progress") {
        setProgress(message.value, message.max);
        setStatus(message.message);
        runStatus.textContent = message.message;
      }

      if (message.type === "complete") {
        activeWorker = null;
        worker.terminate();
        try {
          await downloadBlob(message.blob, downloadName(file.name, type));
          setProgress(1, 1);
          setStatus(message.warning || "EPUB saved.", message.warning ? "warn" : "success");
          runState.textContent = message.warning ? "Saved with warning" : "Saved";
          runStatus.textContent = message.warning || "Download started";
        } catch (error) {
          console.error(error);
          setStatus(friendlyErrorMessage(error), "error");
          runState.textContent = "Error";
          runStatus.textContent = friendlyErrorMessage(error);
        } finally {
          setBusy(false);
        }
      }

      if (message.type === "error") {
        activeWorker = null;
        worker.terminate();
        console.error(message.error);
        setStatus(friendlyErrorMessage(message.error), "error");
        runState.textContent = "Error";
        runStatus.textContent = friendlyErrorMessage(message.error);
        setBusy(false);
      }
    });

    worker.addEventListener("error", (error) => {
      if (activeWorker !== worker) {
        return;
      }

      activeWorker = null;
      worker.terminate();
      console.error(error);
      setStatus("The conversion worker failed to start.", "error");
      runState.textContent = "Error";
      runStatus.textContent = "Worker failed";
      setBusy(false);
    });

    worker.postMessage(
      {
        type: "convert",
        id: jobId,
        payload: {
          sourceFile: file,
          epubType: type,
          metadata,
          pageRange: pageRangeInput.value,
          scale: scaleInput.value,
          performance: {
            hardwareConcurrency: navigator.hardwareConcurrency || 4,
            deviceMemory: navigator.deviceMemory || 8
          },
          runtimeUrls: {
            workerSrc: getRuntimeUrl("libs/pdf.worker.min.mjs"),
            pageWorkerSrc: getRuntimeUrl(PAGE_WORKER_URL),
            cMapUrl: getRuntimeUrl("libs/cmaps/"),
            standardFontDataUrl: getRuntimeUrl("libs/standard_fonts/"),
            wasmUrl: getRuntimeUrl("libs/wasm/")
          }
        }
      }
    );
  } catch (error) {
    activeWorker?.terminate();
    activeWorker = null;
    console.error(error);
    setStatus(friendlyErrorMessage(error), "error");
    runState.textContent = "Error";
    runStatus.textContent = friendlyErrorMessage(error);
    setBusy(false);
  }
});

function selectedPdf() {
  const file = pdfInput.files?.[0];
  return file?.type === "application/pdf" || file?.name.toLowerCase().endsWith(".pdf") ? file : null;
}

function epubType() {
  return document.querySelector('input[name="epubType"]:checked')?.value || "reflowable";
}

function createConversionWorker() {
  return new Worker(getRuntimeUrl(CONVERSION_WORKER_URL), {
    type: "module",
    name: "pdf-to-epub-converter"
  });
}

async function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);

  if (globalThis.chrome?.downloads?.download) {
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename: name, saveAs: false }, (downloadId) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
          } else {
            resolve(downloadId);
          }
        });
      });
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    } catch (error) {
      console.warn("chrome.downloads failed; falling back to a local anchor download.", error);
    }
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setBusy(isBusy) {
  convertButton.disabled = isBusy;
  pdfInput.disabled = isBusy;
  titleInput.disabled = isBusy;
  authorInput.disabled = isBusy;
  languageInput.disabled = isBusy;
  pageRangeInput.disabled = isBusy;
  scaleInput.disabled = isBusy;
  openTabButton.disabled = isBusy;
  progressBar.hidden = !isBusy;
  document.documentElement.classList.toggle("is-converting", isBusy);
}

function setProgress(value, max) {
  const safeMax = Math.max(1, Number(max) || 1);
  const safeValue = Math.min(safeMax, Math.max(0, Number(value) || 0));
  const ratio = safeValue / safeMax;

  progressBar.max = safeMax;
  progressBar.value = safeValue;
  progressFill.style.inlineSize = `${Math.round(ratio * 100)}%`;
}

function setStatus(message, tone = "") {
  status.textContent = message;
  if (tone) {
    status.dataset.tone = tone;
  } else {
    delete status.dataset.tone;
  }
}

function friendlyErrorMessage(error) {
  const message = error?.message || "Conversion failed.";
  const name = error?.name || "";

  if (name === "PasswordException") {
    return "This PDF needs a password before it can be converted.";
  }

  if (name === "InvalidPDFException") {
    return "Chrome could not read this PDF structure.";
  }

  if (/out of memory|allocation|canvas/i.test(message)) {
    return "The PDF was too large for this scale. Try Fixed layout at 1x or convert a page range first.";
  }

  if (/createElement/i.test(message)) {
    return "Chrome used an older PDF rendering worker. Reload the extension in chrome://extensions, close this converter tab, and open it again.";
  }

  return message;
}

function syncLayout() {
  const isTabMode = new URLSearchParams(location.search).get("mode") === "tab" || window.innerWidth >= 700;
  document.documentElement.classList.toggle("tab-mode", isTabMode);
  syncOpenTabButton(isTabMode);
}

function syncOpenTabButton(isTabMode = document.documentElement.classList.contains("tab-mode")) {
  const canOpenExtensionPage = Boolean(globalThis.chrome?.runtime?.getURL);
  openTabButton.hidden = !canOpenExtensionPage || isTabMode;
}

function syncRunSummary() {
  const type = epubType();
  const pageRange = pageRangeInput.value.trim();
  runLayout.textContent = type === "fixed" ? `Fixed layout ${scaleInput.value}x` : "Reflowable";
  runPages.textContent = pageRange || "All";
}

function getRuntimeUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }

  return new URL(path, import.meta.url).href;
}
