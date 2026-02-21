(function () {
  if (window.__firecrawlCtfOrchestratorLoaded) {
    return;
  }
  window.__firecrawlCtfOrchestratorLoaded = true;

  const TARGET_PROBLEM_COUNT = 10;
  const OBSERVER_TIMEOUT_MS = 20000;
  const SOLVE_REQUEST_TIMEOUT_MS = 25000;
  const MAX_SUBMIT_WAIT_MS = 500;
  const FINISH_SAFETY_THRESHOLD_MS = 100;
  const RUN_ARM_KEY = "ctfArmedRun";
  const RUN_ARM_TTL_MS = 60000;
  const LOG_PREFIX = "[ctf-orchestrator]";
  const DEBUG_SOURCE = "content";
  let pendingObserver = null;
  let pendingObserverTimeout = null;
  let pendingPollTimer = null;

  let keepAliveTimer = null;
  const keepAlivePort = chrome.runtime.connect({ name: "ctf-keepalive" });

  keepAliveTimer = window.setInterval(() => {
    try {
      keepAlivePort.postMessage({ type: "ping", timestamp: Date.now() });
    } catch (_error) {
      return;
    }
  }, 12000);

  keepAlivePort.onDisconnect.addListener(() => {
    if (keepAliveTimer) {
      window.clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ctf.runNow") {
      triggerRun({ source: "popup" })
        .then((result) => {
          sendResponse({ ok: true, ...result });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true;
    }

    if (message.type === "ctf.ping") {
      sendResponse({
        ok: true,
        loaded: true,
        inProgress: Boolean(window.__firecrawlCtfRunInProgress),
        queued: Boolean(window.__firecrawlCtfRunQueued),
        snapshot: getDomSnapshot(),
      });
    }
  });

  void bootstrap();

  async function bootstrap() {
    debug("Content script ready. Waiting for manual Run Now trigger.", getDomSnapshot());

    const armedState = await getStorage([RUN_ARM_KEY]).catch(() => ({}));
    const armedRun = armedState && armedState[RUN_ARM_KEY];
    if (!isArmedRunValid(armedRun)) {
      return;
    }

    await removeStorage([RUN_ARM_KEY]).catch(() => {
      return;
    });

    debug("Armed run found on page load. Triggering run.", { armedAt: armedRun.at });
    await triggerRun({ source: "armed" });
  }

  async function triggerRun(options) {
    if (window.__firecrawlCtfRunInProgress) {
      debug("Run ignored because a run is already in progress.");
      return { started: false, reason: "in_progress" };
    }

    if (window.__firecrawlCtfRunQueued) {
      debug("Run requested while already queued.");
      return { started: true, mode: "waiting" };
    }

    const challenge = collectChallenge(true);
    if (!challenge) {
      const startButton = getStartButton();
      if (startButton) {
        await armRun();
        clickButton(startButton);
        queueRunWhenReady();
        debug("START button clicked; waiting for challenge page.");
        return { started: true, mode: "clicked_start" };
      }

      if (!options || options.source !== "armed") {
        await armRun();
      }
      queueRunWhenReady();
      return { started: true, mode: "waiting" };
    }

    await removeStorage([RUN_ARM_KEY]).catch(() => {
      return;
    });

    debug("Challenge found immediately. Starting run.", {
      problemCount: challenge.problems.length,
    });
    void runChallenge(challenge);
    return { started: true, mode: "immediate" };
  }

  function queueRunWhenReady() {
    clearPendingObserver();
    window.__firecrawlCtfRunQueued = true;

    pendingObserver = new MutationObserver(() => {
      checkForChallengeAndRun("mutation");
    });

    pendingObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    pendingPollTimer = window.setInterval(() => {
      checkForChallengeAndRun("poll");
    }, 50);

    pendingObserverTimeout = window.setTimeout(() => {
      clearPendingObserver();
      window.__firecrawlCtfRunQueued = false;
      debug("Queued run expired before challenge board became ready.", getDomSnapshot());
    }, OBSERVER_TIMEOUT_MS);

    debug("Challenge not ready yet. Run queued until board is ready.", getDomSnapshot());
  }

  function checkForChallengeAndRun(reason) {
    const challenge = collectChallenge(false);
    if (!challenge || window.__firecrawlCtfRunInProgress) {
      return;
    }

    clearPendingObserver();
    window.__firecrawlCtfRunQueued = false;
    debug("Queued run became ready.", {
      trigger: reason,
      problemCount: challenge.problems.length,
    });
    void runChallenge(challenge);
  }

  function clearPendingObserver() {
    if (pendingObserver) {
      pendingObserver.disconnect();
      pendingObserver = null;
    }

    if (pendingObserverTimeout) {
      window.clearTimeout(pendingObserverTimeout);
      pendingObserverTimeout = null;
    }

    if (pendingPollTimer) {
      window.clearInterval(pendingPollTimer);
      pendingPollTimer = null;
    }
  }

  async function runChallenge(challenge) {
    if (window.__firecrawlCtfRunInProgress) {
      return;
    }

    window.__firecrawlCtfRunInProgress = true;
    const startTime = performance.now();

    try {
      debug("Run started. Preparing payload.", {
        problemCount: challenge.problems.length,
      });

      const payload = {
        pageUrl: window.location.href,
        problems: challenge.problems.map((problem) => ({
          index: problem.index,
          title: problem.title,
          difficulty: problem.difficulty,
          description: problem.description,
          example: problem.example,
          signature: problem.signature,
        })),
      };

      const response = await sendSolveRequest(payload, SOLVE_REQUEST_TIMEOUT_MS);
      debug("Solver response received.", {
        ok: Boolean(response && response.ok),
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || "Solver call failed.");
      }

      const solutions = response.result && response.result.solutions;
      if (!Array.isArray(solutions) || solutions.length !== challenge.problems.length) {
        throw new Error("Solver response returned invalid solutions array.");
      }

      applySolutions(challenge.problems, solutions);
      await submitAll(challenge.problems, challenge.finishButton);

      const elapsed = Math.round(performance.now() - startTime);
      debug(`Solve and submit sequence completed in ${elapsed}ms.`, {
        solvedCount: readSolvedCount(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(LOG_PREFIX, error);
      debug(`Run failed: ${message}`, getDomSnapshot());
    } finally {
      window.__firecrawlCtfRunInProgress = false;
      window.__firecrawlCtfRunQueued = false;
    }
  }

  function collectChallenge(emitDebug) {
    const problems = collectProblems();
    const finishButton = getFinishButton();
    if (problems.length !== TARGET_PROBLEM_COUNT || !finishButton) {
      if (emitDebug) {
        debug("collectChallenge failed to match board state.", {
          problemCount: problems.length,
          hasFinishButton: Boolean(finishButton),
          snapshot: getDomSnapshot(),
        });
      }
      return null;
    }

    return {
      problems,
      finishButton,
    };
  }

  function collectProblems() {
    const textareas = Array.from(document.querySelectorAll("textarea")).filter((textarea) => {
      const placeholder = normalizeText(textarea.getAttribute("placeholder") || "").toLowerCase();
      return placeholder.startsWith("function ");
    });

    if (textareas.length !== TARGET_PROBLEM_COUNT) {
      return [];
    }

    const problems = textareas
      .map((textarea, fallbackIndex) => {
        const card = textarea.parentElement && textarea.parentElement.parentElement;
        if (!card) {
          return null;
        }

        const spans = Array.from(card.querySelectorAll("span"));
        const indexSpan = spans.find((span) => /^#\d+$/.test(normalizeText(span.textContent)));
        const index =
          indexSpan && Number.isFinite(Number(normalizeText(indexSpan.textContent).slice(1)))
            ? Number(normalizeText(indexSpan.textContent).slice(1))
            : fallbackIndex + 1;

        const title =
          indexSpan && indexSpan.nextElementSibling && indexSpan.nextElementSibling.tagName === "SPAN"
            ? normalizeText(indexSpan.nextElementSibling.textContent)
            : `Problem ${index}`;

        const difficulty =
          spans
            .map((span) => normalizeText(span.textContent).toLowerCase())
            .find((text) => text === "easy" || text === "medium" || text === "hard") || "unknown";

        const description = normalizeMultilineText((card.querySelector("p") || {}).textContent || "");
        const example = normalizeMultilineText((card.querySelector("pre") || {}).textContent || "");
        const signature = normalizeText(
          textarea.getAttribute("placeholder") || extractSignatureFromStarter(textarea.value)
        );

        const submitButton = Array.from(card.querySelectorAll("button")).find(
          (button) => normalizeButtonText(button.textContent) === "SUBMIT"
        );

        if (!submitButton || !signature) {
          return null;
        }

        return {
          index,
          title,
          difficulty,
          description,
          example,
          signature,
          textarea,
          submitButton,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    if (problems.length !== TARGET_PROBLEM_COUNT) {
      return [];
    }

    const uniqueIndexes = new Set(problems.map((problem) => problem.index));
    if (uniqueIndexes.size !== TARGET_PROBLEM_COUNT) {
      return [];
    }

    return problems;
  }

  function getFinishButton() {
    return Array.from(document.querySelectorAll("button")).find(
      (button) => normalizeButtonText(button.textContent) === "FINISH & SUBMIT"
    );
  }

  function getStartButton() {
    return Array.from(document.querySelectorAll("button")).find(
      (button) => normalizeButtonText(button.textContent) === "START"
    );
  }

  function clickButton(button) {
    if (!button) {
      return;
    }

    button.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
      })
    );
    button.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      })
    );
    button.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
      })
    );
    button.click();
  }

  function normalizeButtonText(value) {
    return normalizeText(value).replace(/\s*&\s*/g, " & ");
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeMultilineText(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim();
  }

  function extractSignatureFromStarter(value) {
    const lines = String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.find((line) => line.startsWith("function ")) || "";
  }

  async function armRun() {
    const payload = {
      at: Date.now(),
      url: window.location.href,
    };
    await setStorage({ [RUN_ARM_KEY]: payload });
    debug("Set armed run flag.", payload);
  }

  function isArmedRunValid(runState) {
    if (!runState || typeof runState !== "object") {
      return false;
    }

    const at = Number(runState.at);
    if (!Number.isFinite(at)) {
      return false;
    }

    return Date.now() - at <= RUN_ARM_TTL_MS;
  }

  function sendSolveRequest(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Solver request timed out."));
      }, timeoutMs);

      debug("Sending solve request to background.", {
        problemCount: Array.isArray(payload && payload.problems) ? payload.problems.length : 0,
      });

      chrome.runtime.sendMessage({ type: "solveProblems", payload }, (response) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeout);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      });
    });
  }

  function applySolutions(problems, solutions) {
    debug("Applying solutions into textareas.", {
      solutionCount: solutions.length,
    });

    problems.forEach((problem, index) => {
      const solution = typeof solutions[index] === "string" ? solutions[index].trim() : "";
      if (!solution) {
        return;
      }

      const normalized = normalizeSolutionForSignature(solution, problem.signature);
      setTextareaValue(problem.textarea, normalized);
    });
  }

  function normalizeSolutionForSignature(solution, signature) {
    const targetDeclaration = normalizeFunctionSignature(signature);
    if (!targetDeclaration) {
      return solution;
    }

    const declarationRegex = /function\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)/;
    if (declarationRegex.test(solution)) {
      return solution.replace(declarationRegex, targetDeclaration);
    }

    const trimmed = solution.trim();
    if (trimmed.startsWith("return ") || trimmed.includes("\n")) {
      return `${targetDeclaration} {\n${trimmed}\n}`;
    }

    return `${targetDeclaration} {\n  ${trimmed}\n}`;
  }

  function normalizeFunctionSignature(signature) {
    const base = normalizeText(signature || "").replace(/\s*\{\s*$/, "");
    const match = base.match(/^function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)$/);
    if (!match) {
      return "";
    }
    return match[0];
  }

  function setTextareaValue(textarea, value) {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
    const setter = descriptor && descriptor.set;
    if (!setter) {
      textarea.value = value;
    } else {
      setter.call(textarea, value);
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function submitAll(problems, finishButton) {
    debug("Submitting all individual problems.", {
      count: problems.length,
    });

    for (const problem of problems) {
      clickButton(problem.submitButton);
    }

    const solved = await waitForSolvedCount(TARGET_PROBLEM_COUNT, MAX_SUBMIT_WAIT_MS);

    clickButton(finishButton);
    debug("Clicked FINISH & SUBMIT.", {
      solved,
      remainingMs: readRemainingTimeMs(),
    });
  }

  function waitForSolvedCount(target, timeoutMs) {
    const existing = readSolvedCount();
    if (existing >= target) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const interval = window.setInterval(() => {
        const solved = readSolvedCount();
        const remainingMs = readRemainingTimeMs();
        const timedOut = Date.now() - startedAt >= timeoutMs;
        const nearDeadline = remainingMs !== null && remainingMs <= FINISH_SAFETY_THRESHOLD_MS;

        if (solved >= target || timedOut || nearDeadline) {
          window.clearInterval(interval);
          resolve(solved);
        }
      }, 5);
    });
  }

  function readSolvedCount() {
    const solvedText = Array.from(document.querySelectorAll("span"))
      .map((span) => normalizeText(span.textContent))
      .find((text) => /^\d+\s*\/\s*10$/.test(text));

    if (!solvedText) {
      return -1;
    }

    const numeric = Number(solvedText.split("/")[0].trim());
    return Number.isFinite(numeric) ? numeric : -1;
  }

  function readRemainingTimeMs() {
    const timerText = Array.from(document.querySelectorAll("span"))
      .map((span) => normalizeText(span.textContent))
      .find((text) => /^\d+:\d{2}$/.test(text));

    if (!timerText) {
      return null;
    }

    const [minText, secText] = timerText.split(":");
    const minutes = Number(minText);
    const seconds = Number(secText);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return null;
    }

    return (minutes * 60 + seconds) * 1000;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
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

  function removeStorage(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function getDomSnapshot() {
    const textareaCount = document.querySelectorAll("textarea").length;
    const functionTextareaCount = Array.from(document.querySelectorAll("textarea")).filter((textarea) => {
      const placeholder = normalizeText(textarea.getAttribute("placeholder") || "").toLowerCase();
      return placeholder.startsWith("function ");
    }).length;

    const buttonTexts = Array.from(document.querySelectorAll("button"))
      .map((button) => normalizeButtonText(button.textContent))
      .filter(Boolean);

    const submitButtonCount = buttonTexts.filter((text) => text === "SUBMIT").length;
    const hasFinishButton = buttonTexts.includes("FINISH & SUBMIT");
    const hasStartButton = buttonTexts.includes("START");

    return {
      url: window.location.href,
      readyState: document.readyState,
      textareaCount,
      functionTextareaCount,
      submitButtonCount,
      hasFinishButton,
      hasStartButton,
      solvedCount: readSolvedCount(),
      remainingMs: readRemainingTimeMs(),
    };
  }

  function debug(message, meta) {
    const safeMessage = String(message || "").trim();
    const safeMeta = meta && typeof meta === "object" ? meta : undefined;
    const metaText = safeMeta ? ` ${JSON.stringify(safeMeta)}` : "";
    console.info(`${LOG_PREFIX} ${safeMessage}${metaText}`);

    chrome.runtime.sendMessage(
      {
        type: "debug.append",
        source: DEBUG_SOURCE,
        message: safeMessage,
        meta: safeMeta,
      },
      () => {
        return;
      }
    );
  }
})();
