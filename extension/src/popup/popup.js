const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const runButton = document.getElementById("run");
const optionsButton = document.getElementById("options");
const refreshLogsButton = document.getElementById("refreshLogs");
const clearLogsButton = document.getElementById("clearLogs");
const logsEl = document.getElementById("logs");

initialize();

function initialize() {
  runButton.addEventListener("click", onRunNow);
  optionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  refreshLogsButton.addEventListener("click", loadLogs);
  clearLogsButton.addEventListener("click", clearLogs);

  loadStatus();
  loadLogs();
}

async function loadStatus() {
  try {
    const storage = await storageGet(["openrouterApiKey"]);
    const hasKey = Boolean(String(storage.openrouterApiKey || "").trim());

    const tab = await getActiveTab();
    const isCtfTab = Boolean(tab && isCtfUrl(tab.url));
    const pingState = isCtfTab && tab && typeof tab.id === "number" ? await pingContentScript(tab.id) : null;

    if (!hasKey) {
      statusEl.textContent = "No API key configured. Click Options and add your OpenRouter key.";
      return;
    }

    if (!isCtfTab) {
      statusEl.textContent = "API key found. Open a cheetcode-ctf.firecrawl.dev tab to run.";
      return;
    }

    if (!pingState || !pingState.ok) {
      statusEl.textContent = "API key found. CTF tab open. Content script not reachable yet.";
      return;
    }

    if (pingState.snapshot && pingState.snapshot.hasStartButton) {
      statusEl.textContent = "Entry page detected. Run Now will click START and continue automatically.";
      return;
    }

    const details = pingState.snapshot
      ? ` textareas=${pingState.snapshot.textareaCount}, functionTextareas=${pingState.snapshot.functionTextareaCount}, submitButtons=${pingState.snapshot.submitButtonCount}, finish=${pingState.snapshot.hasFinishButton}`
      : "";
    statusEl.textContent = `Ready on CTF tab.${details}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statusEl.textContent = `Status check error: ${message}`;
  }
}

async function onRunNow() {
  setResult("Triggering run...", false);
  runButton.disabled = true;

  try {
    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No active tab detected.");
    }

    if (!isCtfUrl(tab.url)) {
      throw new Error("Active tab is not the CTF domain.");
    }

    let response;
    try {
      response = await sendMessageToTab(tab.id, { type: "ctf.runNow" });
    } catch (initialError) {
      await injectRunnerScript(tab.id);
      response = await sendMessageToTab(tab.id, { type: "ctf.runNow" });
      if (!response || !response.ok) {
        throw initialError;
      }
    }

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Message failed.");
    }

    if (response.started) {
      if (response.mode === "clicked_start") {
        setResult("Clicked START. Waiting for challenge board, then run will begin.", false);
        await loadLogs();
        return;
      }

      if (response.mode === "waiting") {
        setResult("Challenge still loading. Run queued and will start when board is ready.", false);
        await loadLogs();
        return;
      }

      setResult("Run started on active tab.", false);
      await loadLogs();
      return;
    }

    if (response.reason === "in_progress") {
      setResult("Run already in progress on this tab.", false);
      return;
    }

    setResult("CTF board not detected. Open the challenge tab first.", true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setResult(`Run failed: ${message}`, true);
  } finally {
    runButton.disabled = false;
    await loadStatus();
    await loadLogs();
  }
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs && tabs[0]);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            "Could not reach content script in active tab."
          )
        );
        return;
      }
      resolve(response);
    });
  });
}

function sendMessageToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function injectRunnerScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["src/content/runner.js"],
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      }
    );
  });
}

function isCtfUrl(url) {
  return /^https:\/\/cheetcode-ctf\.firecrawl\.dev(?:\/|$)/.test(String(url || ""));
}

async function pingContentScript(tabId) {
  try {
    const response = await sendMessageToTab(tabId, { type: "ctf.ping" });
    return response;
  } catch (_error) {
    return null;
  }
}

async function loadLogs() {
  try {
    const response = await sendMessageToBackground({ type: "debug.getLogs" });
    if (!response || !response.ok || !Array.isArray(response.logs)) {
      logsEl.textContent = "No logs returned.";
      return;
    }

    const tail = response.logs.slice(-25);
    if (!tail.length) {
      logsEl.textContent = "No logs yet.";
      return;
    }

    logsEl.textContent = tail
      .map((entry) => {
        const time = entry.time ? entry.time.split("T")[1].replace("Z", "") : "";
        const src = entry.source || "unknown";
        const msg = entry.message || "";
        const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
        return `[${time}] ${src}: ${msg}${meta}`;
      })
      .join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logsEl.textContent = `Failed to load logs: ${message}`;
  }
}

async function clearLogs() {
  try {
    const response = await sendMessageToBackground({ type: "debug.clearLogs" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Unable to clear logs.");
    }
    logsEl.textContent = "Logs cleared.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logsEl.textContent = `Failed to clear logs: ${message}`;
  }
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function setResult(message, isError) {
  resultEl.textContent = message;
  resultEl.style.color = isError ? "#b91c1c" : "#166534";
}
