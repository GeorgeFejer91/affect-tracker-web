import { IndexedDbJournalBackend } from "./indexeddb-journal-backend.js";
import { PartialRunRecoveryService } from "./partial-recovery.js";
import { StudyRunJournal } from "./run-journal.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readableTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value ?? "Unknown") : date.toLocaleString();
}

export function partialRecoveryMarkup(runs, issues = []) {
  if (!Array.isArray(runs) || !Array.isArray(issues) || (runs.length === 0 && issues.length === 0)) return "";
  const partialCount = runs.filter((run) => run.status !== "finalized").length;
  const finalizedCount = runs.length - partialCount;
  const discardUnavailable = runs.some((run) => run.discardAllowed === false);
  return `
    <section class="study-recovery" aria-labelledby="study-recovery-title">
      <div>
        <h2 id="study-recovery-title">Stored run evidence</h2>
        <p>${partialCount ? `${partialCount} interrupted run${partialCount === 1 ? "" : "s"}` : "No interrupted runs"} and ${finalizedCount ? `${finalizedCount} finalized run${finalizedCount === 1 ? "" : "s"}` : "no finalized runs"} are stored in this browser. Finalized evidence is retained until explicitly discarded; interrupted stimuli never resume midway.</p>
        ${issues.length ? `<p class="study-status" data-error="true">${issues.length} stored record${issues.length === 1 ? "" : "s"} could not be validated. Healthy records remain available below; preserve browser storage for recovery analysis.</p>` : ""}
        ${discardUnavailable ? '<p class="study-help">Safe discard is unavailable without Web Locks. Preparing downloads remains available.</p>' : ""}
      </div>
      <div class="study-table-wrap">
        <table class="study-table">
          <thead><tr><th>Study and run</th><th>Status</th><th>Last update</th><th>Events</th><th>Actions</th></tr></thead>
          <tbody>${runs.map((run) => `<tr>
            <td><strong>${escapeHtml(run.studyId)}</strong><br><span class="study-meta">${escapeHtml(run.runId)}</span></td>
            <td>${run.status === "finalized"
    ? `Finalized · ${escapeHtml(run.completionStatus)}`
    : run.pendingAction
      ? `Partial · uncommitted ${escapeHtml(run.pendingAction.commandType)} outcome<br><span class="study-meta">Accepted action ${escapeHtml(run.pendingAction.actionId)} is the data-loss boundary.</span>`
      : "Partial"}</td>
            <td>${escapeHtml(readableTime(run.updatedAt))}</td>
            <td>${Number(run.eventCount).toLocaleString()}</td>
            <td><span class="study-inline-actions"><button type="button" data-recovery-export="${escapeHtml(run.runId)}">Prepare downloads</button>${run.discardAllowed === true && run.allowedActions?.some((action) => action.startsWith("discard-")) ? `<button type="button" data-recovery-discard="${escapeHtml(run.runId)}" data-recovery-kind="${run.status === "finalized" ? "finalized" : "partial"}" data-variant="danger">${run.status === "finalized" ? "Discard record" : "Discard and restart"}</button>` : ""}</span><span class="study-inline-actions" data-recovery-downloads hidden></span></td>
          </tr>`).join("")}${issues.map((issue) => `<tr data-recovery-issue><td><strong>Unreadable stored record</strong><br><span class="study-meta">${escapeHtml(issue.recordId)}</span></td><td colspan="4"><span class="study-status" data-error="true">${escapeHtml(issue.message)}</span></td></tr>`).join("")}</tbody>
        </table>
      </div>
      <p class="study-status" data-recovery-status role="status" aria-live="polite"></p>
    </section>`;
}

function assertArtifact(artifact, label) {
  if (!artifact
    || typeof artifact.name !== "string"
    || typeof artifact.type !== "string"
    || typeof artifact.content !== "string") {
    throw new TypeError(`${label} recovery artifact is invalid.`);
  }
  return artifact;
}

function artifactObjectUrl(artifact) {
  const value = assertArtifact(artifact, "Prepared");
  return URL.createObjectURL(new Blob([value.content], { type: value.type }));
}

export function recoveryArtifactLinksMarkup(artifacts, urls) {
  const json = assertArtifact(artifacts?.json, "JSON");
  const csv = assertArtifact(artifacts?.csv, "CSV");
  if (typeof urls?.json !== "string" || typeof urls?.csv !== "string") {
    throw new TypeError("Prepared recovery artifacts require JSON and CSV object URLs.");
  }
  const jsonLabel = artifacts.evidenceStatus === "finalized"
    ? "Download manifest"
    : "Download partial JSON";
  return `<a class="study-button" href="${escapeHtml(urls.json)}" download="${escapeHtml(json.name)}">${jsonLabel}</a><a class="study-button" href="${escapeHtml(urls.csv)}" download="${escapeHtml(csv.name)}">Download CSV</a>`;
}

export function recoveryPreparationMessage(artifacts) {
  const description = artifacts?.evidenceStatus === "finalized"
    ? "Finalized manifest and byte-identical CSV"
    : "Partial JSON and CSV";
  return `${description} prepared. Use both download links. The browser cannot confirm that either file was saved; the stored evidence remains retained.`;
}

export function installPartialRunRecoveryUi({
  root,
  service,
  confirmDiscard = (message) => globalThis.confirm(message),
  createArtifactUrl = artifactObjectUrl,
  revokeArtifactUrl = (url) => URL.revokeObjectURL(url),
  announce = () => {},
} = {}) {
  if (!root?.addEventListener) throw new TypeError("A recovery UI root is required.");
  let ownedService;
  if (!service && globalThis.indexedDB && globalThis.IDBKeyRange) {
    ownedService = new PartialRunRecoveryService({
      journal: new StudyRunJournal({ backend: new IndexedDbJournalBackend() }),
    });
  }
  const recovery = service ?? ownedService;
  let refreshSequence = 0;
  let closed = false;
  const preparedUrls = new Map();

  const revokePrepared = (runId) => {
    for (const url of preparedUrls.get(runId) ?? []) revokeArtifactUrl(url);
    preparedUrls.delete(runId);
  };

  const revokeAllPrepared = () => {
    for (const runId of preparedUrls.keys()) revokePrepared(runId);
  };

  const refresh = async (mount) => {
    const sequence = ++refreshSequence;
    if (!mount || closed) return;
    revokeAllPrepared();
    if (!recovery) {
      mount.hidden = true;
      mount.replaceChildren();
      return;
    }
    mount.hidden = false;
    mount.innerHTML = '<p class="study-status" aria-busy="true">Checking for interrupted run evidence…</p>';
    try {
      const listing = typeof recovery.listWithIssues === "function"
        ? await recovery.listWithIssues()
        : { runs: await recovery.list(), issues: [] };
      const { runs, issues } = listing;
      if (closed || sequence !== refreshSequence || !mount.isConnected) return;
      mount.innerHTML = partialRecoveryMarkup(runs, issues);
      mount.hidden = runs.length === 0 && issues.length === 0;
      if (runs.length === 0 && issues.length === 0) return;
      const status = mount.querySelector("[data-recovery-status]");
      for (const button of mount.querySelectorAll("[data-recovery-export]")) {
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const artifacts = await recovery.export(button.dataset.recoveryExport);
            if (closed || sequence !== refreshSequence || !mount.isConnected) return;
            const urls = [];
            try {
              urls.push(createArtifactUrl(artifacts.json));
              urls.push(createArtifactUrl(artifacts.csv));
            } catch (error) {
              for (const url of urls) revokeArtifactUrl(url);
              throw error;
            }
            const downloads = button.closest("td")?.querySelector("[data-recovery-downloads]");
            if (!downloads) {
              for (const url of urls) revokeArtifactUrl(url);
              throw new Error("The recovery download area is unavailable.");
            }
            revokePrepared(button.dataset.recoveryExport);
            preparedUrls.set(button.dataset.recoveryExport, urls);
            downloads.innerHTML = recoveryArtifactLinksMarkup(artifacts, {
              json: urls[0],
              csv: urls[1],
            });
            downloads.hidden = false;
            delete status.dataset.error;
            status.textContent = recoveryPreparationMessage(artifacts);
            announce(`${artifacts.evidenceStatus === "finalized" ? "Finalized" : "Partial"} run download links prepared.`);
          } catch (error) {
            status.textContent = error?.message ?? String(error);
            status.dataset.error = "true";
          } finally {
            button.disabled = false;
          }
        });
      }
      for (const button of mount.querySelectorAll("[data-recovery-discard]")) {
        button.addEventListener("click", async () => {
          const runId = button.dataset.recoveryDiscard;
          const kind = button.dataset.recoveryKind === "finalized" ? "finalized" : "partial";
          if (!confirmDiscard(`Permanently discard ${kind} run ${runId}? Prepare both downloads and confirm they are saved first if the evidence must be retained.`)) return;
          button.disabled = true;
          try {
            await recovery.discard(runId);
            announce(kind === "finalized"
              ? "Finalized run record discarded."
              : "Partial run discarded. Start a new run from the beginning.");
            await refresh(mount);
          } catch (error) {
            status.textContent = error?.message ?? String(error);
            status.dataset.error = "true";
            button.disabled = false;
          }
        });
      }
    } catch (error) {
      if (closed || sequence !== refreshSequence || !mount.isConnected) return;
      mount.hidden = false;
      mount.innerHTML = `<section class="study-recovery"><h2>Stored run evidence</h2><p class="study-status" data-error="true">${escapeHtml(error?.message ?? error)}</p></section>`;
    }
  };

  const onRefresh = (event) => { void refresh(event.detail?.mount); };
  root.addEventListener("study:recovery-refresh", onRefresh);
  return Object.freeze({
    refresh,
    async close() {
      if (closed) return;
      closed = true;
      refreshSequence += 1;
      revokeAllPrepared();
      root.removeEventListener("study:recovery-refresh", onRefresh);
      await ownedService?.close();
    },
  });
}
