const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";
const PROVIDER_ORDER = ["cerebras"];
const REQUEST_TIMEOUT_MS = 16000;
const DEBUG_LOG_KEY = "ctfDebugLogs";
const DEBUG_LOG_LIMIT = 300;

let cachedApiKey = null;

chrome.runtime.onInstalled.addListener(() => {
  debugLog("background", "Extension installed.");
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.openrouterApiKey) {
    cachedApiKey = null;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ctf-keepalive") {
    return;
  }

  port.onMessage.addListener(() => {
    return;
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "debug.append") {
    appendDebugLog({
      source: sanitizeText(message.source || "content"),
      message: sanitizeMultilineText(message.message || ""),
      meta: message.meta && typeof message.meta === "object" ? message.meta : undefined,
      senderUrl: sender && sender.url,
    })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (message.type === "debug.getLogs") {
    getDebugLogs()
      .then((logs) => {
        sendResponse({ ok: true, logs });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (message.type === "debug.clearLogs") {
    setStorage({ [DEBUG_LOG_KEY]: [] })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (message.type !== "solveProblems") {
    return;
  }

  debugLog("background", "Received solveProblems message.", {
    senderUrl: sender && sender.url,
    hasPayload: Boolean(message.payload),
  });

  solveProblems(message.payload, sender)
    .then((result) => {
      debugLog("background", "solveProblems completed.", {
        solutionCount: Array.isArray(result && result.solutions) ? result.solutions.length : 0,
      });
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      debugLog("background", "solveProblems failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

async function solveProblems(payload, sender) {
  const problems = normalizeProblems(payload && payload.problems);
  debugLog("background", "Normalized problems.", { count: problems.length });
  if (problems.length !== 10) {
    throw new Error(`Expected 10 problems, got ${problems.length}.`);
  }

  const apiKey = await getCachedApiKey();
  if (!apiKey) {
    throw new Error("OpenRouter API key missing. Set it in extension options.");
  }

  debugLog("background", "Firing parallel OpenRouter calls.", {
    model: MODEL,
    providerOrder: PROVIDER_ORDER,
    problemCount: problems.length,
  });

  const headers = buildHeaders(apiKey, sender && sender.url);
  const results = await Promise.allSettled(
    problems.map((problem) => solveSingleProblem(problem, headers))
  );

  const solutions = [];
  const failures = [];
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      solutions.push(result.value);
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ index: problems[idx].index, error: errMsg });
      solutions.push(null);
    }
  });

  if (failures.length > 0) {
    debugLog("background", "Some parallel calls failed.", { failures });
    throw new Error(
      failures.length + " problem(s) failed: " +
      failures.map((f) => "#" + f.index + ": " + f.error).join("; ")
    );
  }

  debugLog("background", "All parallel calls succeeded.", { count: solutions.length });
  return {
    model: MODEL,
    providerOrder: PROVIDER_ORDER,
    solutions,
  };
}

function buildHeaders(apiKey, senderUrl) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "Firecrawl CTF Orchestrator",
  };

  if (senderUrl) {
    headers["HTTP-Referer"] = senderUrl;
  }

  return headers;
}

async function solveSingleProblem(problem, headers) {
  const body = {
    model: MODEL,
    stream: false,
    temperature: 0,
    top_p: 1,
    max_tokens: 256,
    provider: {
      order: PROVIDER_ORDER,
      allow_fallbacks: false,
      require_parameters: true,
      sort: "throughput",
    },
    messages: [
      {
        role: "system",
        content: "Solve this JavaScript task. Return ONLY the function code. No markdown. No explanation.",
      },
      {
        role: "user",
        content: problem.signature + "\n" + problem.description + (problem.example ? "\n" + problem.example : ""),
      },
    ],
  };

  const response = await postJsonWithTimeout(OPENROUTER_API_URL, headers, body, REQUEST_TIMEOUT_MS);
  return extractSolutionText(response);
}

function extractSolutionText(apiResponse) {
  const message = apiResponse && apiResponse.choices && apiResponse.choices[0] && apiResponse.choices[0].message;
  if (!message) {
    throw new Error("OpenRouter response missing choices[0].message.");
  }
  const text = extractMessageText(message.content);
  const clean = stripCodeFences(text);
  if (!clean) {
    throw new Error("Empty solution from model.");
  }
  return clean;
}

function normalizeProblems(rawProblems) {
  if (!Array.isArray(rawProblems)) {
    return [];
  }

  return rawProblems
    .map((problem, fallbackIndex) => {
      const indexValue = Number(problem && problem.index);
      const index = Number.isFinite(indexValue) && indexValue > 0 ? indexValue : fallbackIndex + 1;

      return {
        index,
        title: sanitizeText(problem && problem.title),
        difficulty: sanitizeText(problem && problem.difficulty),
        signature: sanitizeText(problem && problem.signature),
        description: sanitizeMultilineText(problem && problem.description),
        example: sanitizeMultilineText(problem && problem.example),
      };
    })
    .filter((problem) => problem.signature)
    .sort((a, b) => a.index - b.index);
}

function sanitizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeMultilineText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        if (item && typeof item.content === "string") {
          return item.content;
        }
        return "";
      })
      .join("")
      .trim();
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text.trim();
    }
    if (typeof content.content === "string") {
      return content.content.trim();
    }
  }

  return "";
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function stripCodeFences(solution) {
  if (!solution.startsWith("```")) {
    return solution;
  }

  return solution
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

async function postJsonWithTimeout(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseText = await response.text();
    debugLog("background", "OpenRouter response received.", {
      status: response.status,
      ok: response.ok,
      bodyPreview: responseText.slice(0, 200),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter error ${response.status}: ${responseText.slice(0, 400)}`);
    }

    const json = tryParseJson(responseText);
    if (json === null) {
      throw new Error("OpenRouter returned non-JSON response.");
    }

    return json;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`OpenRouter request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function debugLog(source, message, meta) {
  const safeMessage = sanitizeMultilineText(message || "");
  const entry = {
    time: new Date().toISOString(),
    source: sanitizeText(source || "background"),
    message: safeMessage,
    meta: meta && typeof meta === "object" ? meta : undefined,
  };

  const metaText = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
  console.info(`[ctf-orchestrator][${entry.source}] ${entry.message}${metaText}`);

  appendDebugLog(entry).catch((_error) => {
    return;
  });
}

async function appendDebugLog(entry) {
  const current = await getStorage([DEBUG_LOG_KEY]);
  const logs = Array.isArray(current[DEBUG_LOG_KEY]) ? current[DEBUG_LOG_KEY] : [];
  logs.push({
    time: entry.time || new Date().toISOString(),
    source: sanitizeText(entry.source || "unknown"),
    message: sanitizeMultilineText(entry.message || ""),
    meta: entry.meta && typeof entry.meta === "object" ? entry.meta : undefined,
    senderUrl: entry.senderUrl ? sanitizeText(entry.senderUrl) : undefined,
  });

  const trimmedLogs = logs.slice(-DEBUG_LOG_LIMIT);
  await setStorage({ [DEBUG_LOG_KEY]: trimmedLogs });
}

async function getDebugLogs() {
  const result = await getStorage([DEBUG_LOG_KEY]);
  return Array.isArray(result[DEBUG_LOG_KEY]) ? result[DEBUG_LOG_KEY] : [];
}

function getStorage(keys) {
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

function setStorage(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function getCachedApiKey() {
  if (cachedApiKey) {
    return cachedApiKey;
  }
  cachedApiKey = await getStoredApiKey();
  return cachedApiKey;
}

function getStoredApiKey() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(["openrouterApiKey"], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(String(result.openrouterApiKey || "").trim());
    });
  });
}
