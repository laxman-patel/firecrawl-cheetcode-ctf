const apiKeyInput = document.getElementById("apiKey");
const saveButton = document.getElementById("save");
const clearButton = document.getElementById("clear");
const showKeyCheckbox = document.getElementById("showKey");
const statusEl = document.getElementById("status");

initialize();

function initialize() {
  loadStoredKey();

  saveButton.addEventListener("click", onSave);
  clearButton.addEventListener("click", onClear);
  showKeyCheckbox.addEventListener("change", onToggleShowKey);
}

function loadStoredKey() {
  chrome.storage.local.get(["openrouterApiKey"], (result) => {
    if (chrome.runtime.lastError) {
      setStatus(`Load failed: ${chrome.runtime.lastError.message}`, true);
      return;
    }

    const stored = String(result.openrouterApiKey || "").trim();
    if (stored) {
      apiKeyInput.value = stored;
      setStatus("API key loaded.", false);
      return;
    }

    setStatus("No API key set yet.", false);
  });
}

function onSave() {
  const apiKey = String(apiKeyInput.value || "").trim();
  if (!apiKey) {
    setStatus("Please enter a valid API key.", true);
    return;
  }

  chrome.storage.local.set({ openrouterApiKey: apiKey }, () => {
    if (chrome.runtime.lastError) {
      setStatus(`Save failed: ${chrome.runtime.lastError.message}`, true);
      return;
    }

    setStatus("API key saved.", false);
  });
}

function onClear() {
  chrome.storage.local.remove(["openrouterApiKey"], () => {
    if (chrome.runtime.lastError) {
      setStatus(`Clear failed: ${chrome.runtime.lastError.message}`, true);
      return;
    }

    apiKeyInput.value = "";
    setStatus("API key removed.", false);
  });
}

function onToggleShowKey() {
  apiKeyInput.type = showKeyCheckbox.checked ? "text" : "password";
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b91c1c" : "#166534";
}
