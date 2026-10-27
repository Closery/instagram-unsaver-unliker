/**
 * Instagram Unsaver & Unliker — content script.
 *
 * Instagram only exposes unsaving through the post viewer, and the request
 * behind it is a persisted GraphQL mutation whose `doc_id` changes between
 * builds. Instead of reverse engineering that request, this extension drives
 * the UI the way a person would:
 *
 *   1. open a post from your saved list,
 *   2. press START,
 *   3. the script clicks the bookmark button, then the "next" arrow, and
 *      repeats until the viewer runs out of saved posts or you press STOP.
 *
 * The script never calls Instagram's API itself — every request is made by the
 * page in response to a click. Nothing is stored or sent anywhere except the
 * delay you pick under "Advanced settings", which stays in chrome.storage.local.
 *
 * Bulk unlike (the second half of the name) reuses the same loop: it only needs
 * the filled-heart icon path and a second button, since the loop does not care
 * which control it is clicking.
 */
(() => {
	"use strict";

	// ---------------------------------------------------------------------------
	// Configuration
	// ---------------------------------------------------------------------------

	/** `https://www.instagram.com/<username>/saved/`, `.../saved/all-posts/`, ... */
	const SAVED_PATH = /^\/(?:[^/]+\/)?saved(?:\/|$)/;

	/** `https://www.instagram.com/p/<shortcode>/` and its variants. */
	const POST_PATH = /^\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/;

	/** Filled bookmark icon — only rendered while the open post is saved. */
	const UNSAVE_ICON_PATH =
		"M20 22a.999.999 0 0 1-.687-.273L12 14.815l-7.313 6.912A1 1 0 0 1 3 21V3a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1Z";

	/** "Next post" chevron in the post viewer. */
	const NEXT_ICON_PATH =
		"M21 17.502a.997.997 0 0 1-.707-.293L12 8.913l-8.293 8.296a1 1 0 1 1-1.414-1.414l9-9.004a1.03 1.03 0 0 1 1.414 0l9 9.004A1 1 0 0 1 21 17.502Z";

	/**
	 * Delay between clicks, adjustable under "Advanced settings" in 50 ms steps.
	 * 300 ms is the fast default; 1500 ms roughly keeps two requests per post
	 * inside Instagram's ~200 requests / 5 minutes budget.
	 */
	const MIN_DELAY_MS = 300;
	const MAX_DELAY_MS = 1500;
	const DELAY_STEP_MS = 50;
	const DEFAULT_DELAY_MS = 300;

	const STORAGE_KEY = "delayMs";

	const BUTTON_TIMEOUT_MS = 5000;
	const NEXT_TIMEOUT_MS = 5000;
	const POLL_INTERVAL_MS = 50;

	const strings = {
		start: "START",
		stop: "STOP",
		openPost:
			"Open any post from your saved list, then press START. The extension unsaves it and moves on to the next one.",
		ready: "Ready. Press START to unsave this post and the ones after it.",
		keepOpen: "Keep this tab open. Press STOP to end the run.",
		notSaved:
			"This post doesn’t look saved, or Instagram changed the bookmark icon. Open a post from your saved list and try again.",
	};

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	const state = {
		mode: "idle", // idle | running | finished | failed
		abort: false,
		unsaved: 0,
		delay: DEFAULT_DELAY_MS,
		advancedOpen: false,
	};

	let panel = null;
	let lastPath = null;
	let saveTimer = null;

	// ---------------------------------------------------------------------------
	// Boot
	// ---------------------------------------------------------------------------

	syncRoute();
	setInterval(syncRoute, 500);
	loadDelay();

	function isPostPage() {
		return POST_PATH.test(window.location.pathname);
	}

	function isSavedPage() {
		return SAVED_PATH.test(window.location.pathname);
	}

	/**
	 * Keeps the panel in sync with Instagram's client-side navigation. The panel
	 * follows the viewer from post to post during a run, so only leaving both
	 * routes cancels it.
	 */
	function syncRoute() {
		if (!document.body) return;

		const postPage = isPostPage();
		const savedPage = isSavedPage();

		if (!postPage && !savedPage) {
			unmountPanel();
			return;
		}

		mountPanel();

		if (state.mode === "running" && !postPage) state.abort = true;

		if (lastPath !== window.location.pathname) {
			lastPath = window.location.pathname;
			if (state.mode === "finished" || state.mode === "failed") {
				state.mode = "idle";
			}
		}

		if (state.mode === "idle") {
			setStatus(savedPage ? strings.openPost : strings.ready);
		}

		refreshControls();
	}

	// ---------------------------------------------------------------------------
	// Panel
	// ---------------------------------------------------------------------------

	function mountPanel() {
		if (panel) {
			// Instagram occasionally replaces large parts of the DOM; re-attach.
			if (!document.contains(panel)) document.body.appendChild(panel);
			return;
		}

		panel = buildPanel();
		document.body.appendChild(panel);
		panel.addEventListener("click", onPanelClick);
		panel.addEventListener("input", onPanelInput);
		applyDelayToControls();
	}

	function unmountPanel() {
		if (!panel) return;

		state.abort = true;
		state.mode = "idle";

		panel.remove();
		panel = null;
	}

	function buildPanel() {
		const element = document.createElement("div");
		element.id = "igu-panel";
		element.className = "igu-panel";
		element.innerHTML = `
      <div class="igu-head">
        <span class="igu-title">Unsaver &amp; Unliker</span>
        <button type="button" class="igu-icon-btn" data-action="collapse"
                aria-label="Collapse panel">&#8722;</button>
      </div>
      <div class="igu-body">
        <p class="igu-status" data-ref="status" aria-live="polite"></p>
        <div class="igu-bar" data-ref="bar" hidden>
          <div class="igu-bar-fill igu-indeterminate"></div>
        </div>
        <div class="igu-actions igu-actions-trailing">
          <button type="button" class="igu-btn igu-btn-primary"
                  data-action="start">${strings.start}</button>
          <button type="button" class="igu-btn igu-btn-danger"
                  data-action="stop" hidden>${strings.stop}</button>
        </div>
        <div class="igu-advanced">
          <button type="button" class="igu-advanced-toggle"
                  data-action="advanced" aria-expanded="false">
            <span>Advanced settings</span>
            <span class="igu-chevron" aria-hidden="true">&#9662;</span>
          </button>
          <div class="igu-advanced-body" data-ref="advanced" hidden>
            <div class="igu-field">
              <label for="igu-delay">Delay between actions</label>
              <span class="igu-field-value" data-ref="delayValue"></span>
            </div>
            <input id="igu-delay" class="igu-range" data-ref="delay"
                   type="range" min="${MIN_DELAY_MS}" max="${MAX_DELAY_MS}"
                   step="${DELAY_STEP_MS}" value="${state.delay}" />
            <p class="igu-hint">
              Lower is faster but more likely to hit Instagram’s rate limit.
            </p>
          </div>
        </div>
      </div>
    `;

		if (state.advancedOpen) {
			const body = element.querySelector('[data-ref="advanced"]');
			const toggle = element.querySelector('[data-action="advanced"]');
			if (body) body.hidden = false;
			if (toggle) toggle.setAttribute("aria-expanded", "true");
		}

		return element;
	}

	function q(selector) {
		return panel ? panel.querySelector(selector) : null;
	}

	function onPanelClick(event) {
		const target = event.target instanceof Element ? event.target : null;
		const button = target ? target.closest("button[data-action]") : null;
		if (!button) return;

		switch (button.dataset.action) {
			case "start":
				run();
				break;
			case "stop":
				state.abort = true;
				setStatus("Stopping…");
				break;
			case "advanced":
				toggleAdvanced();
				break;
			case "collapse":
				toggleCollapsed();
				break;
		}
	}

	function onPanelInput(event) {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target.dataset.ref !== "delay") return;

		state.delay = clampDelay(Number(target.value));
		applyDelayToControls();
		scheduleSave();
	}

	function toggleAdvanced() {
		const body = q('[data-ref="advanced"]');
		const toggle = q('[data-action="advanced"]');
		if (!body) return;

		state.advancedOpen = body.hidden;
		body.hidden = !state.advancedOpen;
		if (toggle)
			toggle.setAttribute("aria-expanded", String(state.advancedOpen));
	}

	function toggleCollapsed() {
		if (!panel) return;

		const collapsed = panel.classList.toggle("igu-collapsed");
		const button = q('[data-action="collapse"]');
		if (button) {
			button.innerHTML = collapsed ? "&#43;" : "&#8722;";
			button.setAttribute(
				"aria-label",
				collapsed ? "Expand panel" : "Collapse panel",
			);
		}
	}

	// ---------------------------------------------------------------------------
	// Panel rendering
	// ---------------------------------------------------------------------------

	function setStatus(text) {
		const status = q('[data-ref="status"]');
		if (status && status.textContent !== text) status.textContent = text;
	}

	function refreshControls() {
		const running = state.mode === "running";
		const start = q('[data-action="start"]');
		const stop = q('[data-action="stop"]');

		if (start) start.disabled = running || !isPostPage();
		if (stop) stop.hidden = !running;
	}

	function applyDelayToControls() {
		const input = q('[data-ref="delay"]');
		const value = q('[data-ref="delayValue"]');

		if (input) input.value = String(state.delay);
		if (value) value.textContent = `${state.delay} ms`;
	}

	// ---------------------------------------------------------------------------
	// Settings
	// ---------------------------------------------------------------------------

	function loadDelay() {
		try {
			chrome.storage.local.get(STORAGE_KEY, (result) => {
				if (chrome.runtime.lastError) return;

				const stored = Number(result && result[STORAGE_KEY]);
				if (!Number.isFinite(stored)) return;

				state.delay = clampDelay(stored);
				applyDelayToControls();
			});
		} catch (error) {
			// Storage is unavailable (for example after reloading the extension);
			// keep the default for this page.
		}
	}

	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(saveDelay, 250);
	}

	function saveDelay() {
		try {
			chrome.storage.local.set({ [STORAGE_KEY]: state.delay });
		} catch (error) {
			// Ignore: the setting simply will not survive a reload.
		}
	}

	function clampDelay(value) {
		if (!Number.isFinite(value)) return DEFAULT_DELAY_MS;

		const stepped = Math.round(value / DELAY_STEP_MS) * DELAY_STEP_MS;
		return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, stepped));
	}

	// ---------------------------------------------------------------------------
	// Run
	// ---------------------------------------------------------------------------

	async function run() {
		if (state.mode === "running" || !isPostPage()) return;

		state.mode = "running";
		state.abort = false;
		state.unsaved = 0;

		const bar = q('[data-ref="bar"]');
		if (bar) bar.hidden = false;

		setStatus("Looking for the bookmark button…");
		refreshControls();

		try {
			while (!state.abort) {
				const unsaveButton = await waitFor(
					findUnsaveButton,
					BUTTON_TIMEOUT_MS,
				);

				if (!unsaveButton) {
					if (state.abort) break;
					if (state.unsaved === 0) throw new Error(strings.notSaved);
					break;
				}

				unsaveButton.click();
				state.unsaved += 1;
				setStatus(
					`Unsaved ${count(state.unsaved)}… ${strings.keepOpen}`,
				);

				await sleep(state.delay);
				if (state.abort) break;

				const nextButton = await waitFor(
					findNextButton,
					NEXT_TIMEOUT_MS,
				);
				// Running out of next posts is the normal end of the saved list.
				if (!nextButton) break;

				nextButton.click();
				await sleep(state.delay);
			}

			if (state.abort) {
				finish(`Stopped. Unsaved ${count(state.unsaved)}.`);
			} else {
				finish(`Done. Unsaved ${count(state.unsaved)}.`);
			}
		} catch (error) {
			finish(
				error && error.message ? error.message : String(error),
				true,
			);
		}
	}

	function finish(message, failed = false) {
		state.mode = failed ? "failed" : "finished";
		state.abort = true;

		const bar = q('[data-ref="bar"]');
		if (bar) bar.hidden = true;

		setStatus(message);
		refreshControls();
	}

	// ---------------------------------------------------------------------------
	// Finding Instagram's controls
	// ---------------------------------------------------------------------------

	/**
	 * Walks up from the icon to whatever element actually handles the click.
	 * Instagram renders these controls as `div[role="button"]` with a nested
	 * `<svg>`, not as real buttons.
	 */
	function closestClickable(svg) {
		let element = svg.parentElement;

		for (let depth = 0; depth < 5 && element; depth++) {
			if (
				element.getAttribute("role") === "button" ||
				element.getAttribute("tabindex") !== null ||
				typeof element.onclick === "function"
			) {
				return element;
			}
			element = element.parentElement;
		}

		return svg.parentElement;
	}

	/** Finds the control whose icon matches, e.g. the filled bookmark. */
	function findControl(iconPath) {
		for (const svg of document.querySelectorAll("svg")) {
			if (!svg.querySelector(`path[d="${iconPath}"]`)) continue;
			return closestClickable(svg);
		}

		return null;
	}

	function findUnsaveButton() {
		return findControl(UNSAVE_ICON_PATH);
	}

	function findNextButton() {
		for (const svg of document.querySelectorAll('svg[aria-label="Next"]')) {
			if (svg.querySelector(`path[d="${NEXT_ICON_PATH}"]`)) {
				return closestClickable(svg);
			}
		}

		return null;
	}

	async function waitFor(evaluate, timeoutMs) {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (state.abort) return null;

			const value = evaluate();
			if (value) return value;

			await sleep(POLL_INTERVAL_MS);
		}

		return null;
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	function count(number) {
		return `${number} post${number === 1 ? "" : "s"}`;
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
})();
