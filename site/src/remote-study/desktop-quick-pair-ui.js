import { DesktopStudyQuickPairTarget } from "./desktop-quick-pair-target.js";
import { renderQrCode } from "./qr-code.js";

function formatTime(value) {
  if (!Number.isSafeInteger(value)) return "Unavailable";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function titleCase(value) {
  return String(value ?? "unavailable")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (character) => character.toUpperCase());
}

export function grantedRemoteScopeText(snapshot) {
  return snapshot?.lease?.active && Array.isArray(snapshot.lease.scopes)
    ? snapshot.lease.scopes.join(", ")
    : "None";
}

export function selectInvitationText(host) {
  const invitationText = host?.querySelector?.("#study-remote-invitation-url");
  if (!invitationText) return false;
  invitationText.focus?.();
  invitationText.select?.();
  return true;
}

export async function copyInvitationLink({ invitationUrl, clipboard, host } = {}) {
  if (typeof invitationUrl !== "string" || invitationUrl.length === 0) return "unavailable";
  try {
    if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard unavailable.");
    await clipboard.writeText(invitationUrl);
    return "copied";
  } catch {
    return selectInvitationText(host) ? "selected" : "unavailable";
  }
}

export function createDesktopQuickPairUi({ invoke, authorityBridge, announce = () => {} } = {}) {
  const bridgeInvoke = async (command, args) => {
    const result = await invoke(command, args);
    if (command === "apply_study_action") {
      authorityBridge?.acceptExternalOutcome?.(args?.action, result);
    }
    return result;
  };
  const target = new DesktopStudyQuickPairTarget({ invoke: bridgeInvoke });
  let host;

  const element = (selector) => host?.querySelector(selector);

  function update(message, error = false) {
    if (!host?.isConnected) return;
    const snapshot = target.snapshot();
    const state = snapshot.state;
    const enabled = snapshot.phase !== "disabled" && snapshot.phase !== "error";
    const status = element("#study-remote-status");
    status.textContent = message ?? (enabled ? "Remote Control is enabled." : "Remote Control is disabled.");
    status.dataset.error = String(error);
    element("#study-remote-enable").disabled = enabled;
    element("#study-remote-stop").disabled = !enabled;
    element("#study-remote-copy").disabled = !snapshot.invitationUrl;
    element("#study-remote-auth").textContent = snapshot.invitationConsumed
      ? "QR invitation · proof accepted"
      : enabled ? "QR invitation · waiting for controller" : "QR invitation · inactive";
    element("#study-remote-scopes").textContent = grantedRemoteScopeText(snapshot);
    element("#study-remote-brsp").textContent = titleCase(snapshot.brspPhase);
    element("#study-remote-route").textContent = snapshot.route === "unknown"
      ? "Unknown"
      : `${titleCase(snapshot.route)}${Number.isFinite(snapshot.rttMs) ? ` · ${snapshot.rttMs} ms RTT` : ""}`;
    element("#study-remote-controller").textContent = snapshot.controllerId
      ? "One authenticated browser"
      : "None";
    element("#study-remote-lease").textContent = snapshot.lease.active
      ? `${Math.ceil(snapshot.lease.remainingMs / 1000)} seconds remaining`
      : "Inactive";
    element("#study-remote-run").textContent = state
      ? `${state.runId} · ${titleCase(state.phase)} · revision ${state.revision}`
      : "No active native run";
    element("#study-remote-last-command").textContent = snapshot.lastApplied
      ? `${snapshot.lastApplied.action}: ${snapshot.lastApplied.ok ? "applied" : snapshot.lastApplied.error}`
      : "None";

    const invitationPanel = element("#study-remote-invitation");
    const invitationText = element("#study-remote-invitation-url");
    const qrHost = element("#study-remote-qr");
    invitationPanel.hidden = !snapshot.invitationUrl;
    if (snapshot.invitationUrl) {
      invitationText.value = snapshot.invitationUrl;
      element("#study-remote-expiry").textContent = `Expires at ${formatTime(snapshot.invitationExpiresAtMs)} if it is not used.`;
      renderQrCode(qrHost, snapshot.invitationUrl);
    } else {
      invitationText.value = "";
      qrHost.replaceChildren();
    }
  }

  target.addEventListener("statuschange", (event) => {
    update(event.detail.message, event.detail.error);
    announce(event.detail.message);
  });

  function mount(nextHost) {
    host = nextHost;
    host.innerHTML = `
      <section class="study-step">
        <h2>Remote Control</h2>
        <p>Enable one browser to observe and control the active native study through a fresh private data-only session.</p>

        <div class="study-inline-actions study-remote-primary-actions">
          <button id="study-remote-enable" type="button" data-variant="primary">Enable Remote Control</button>
          <button id="study-remote-stop" type="button" data-variant="danger" disabled>Stop Remote Control</button>
        </div>
        <p id="study-remote-status" class="study-status" role="status" aria-live="polite">Remote Control is disabled. No networking has started.</p>

        <section id="study-remote-invitation" class="study-section-box study-remote-invitation" hidden>
          <div>
            <h3>One-time QR invitation</h3>
            <p>Scan this code with the researcher browser. The fragment contains a 192-bit bearer secret; keep it out of screenshots and messages.</p>
            <label class="study-field"><span>Invitation link</span><textarea id="study-remote-invitation-url" rows="4" readonly></textarea></label>
            <div class="study-inline-actions"><button id="study-remote-copy" type="button">Copy invitation link</button></div>
            <p id="study-remote-expiry" class="study-help"></p>
          </div>
          <div id="study-remote-qr" class="study-remote-qr"></div>
        </section>

        <div class="study-table-wrap">
          <table class="study-table">
            <tbody>
              <tr><th scope="row">Authentication</th><td id="study-remote-auth">QR invitation · inactive</td></tr>
              <tr><th scope="row">Granted scopes</th><td id="study-remote-scopes">None</td></tr>
              <tr><th scope="row">BRSP status</th><td id="study-remote-brsp">Idle</td></tr>
              <tr><th scope="row">Controller</th><td id="study-remote-controller">None</td></tr>
              <tr><th scope="row">Controller lease</th><td id="study-remote-lease">Inactive</td></tr>
              <tr><th scope="row">Route</th><td id="study-remote-route">Unknown</td></tr>
              <tr><th scope="row">Native run</th><td id="study-remote-run">No active native run</td></tr>
              <tr><th scope="row">Last remote command</th><td id="study-remote-last-command">None</td></tr>
            </tbody>
          </table>
        </div>

        <section class="study-section-box">
          <h3>Network and security boundary</h3>
          <ul class="study-remote-boundaries">
            <li>This slice implements QR high-entropy BRSP/1 pairing with only <code>study.observe</code> and <code>study.control</code>.</li>
            <li>OPAQUE password-file login, passwordless local approval, the public beacon, record export, and reconnect are not implemented.</li>
            <li>VDO.Ninja uses Internet signaling, STUN, and possibly TURN. A direct path may expose peer network addresses; relay paths may add latency.</li>
            <li>BRSP proof and scope enforcement currently live in this bundled WebView. Rust revalidates the resulting typed study action through its native authority. This is not the final security architecture.</li>
            <li>Public VDO, forced-TURN, physical phone, and packaged WebView2/WKWebView/WebKitGTK qualification remain open.</li>
          </ul>
        </section>
      </section>`;

    element("#study-remote-enable").addEventListener("click", async () => {
      try {
        await target.enable();
        update("Remote Control enabled. Scan the one-time QR invitation.");
      } catch (error) {
        update(error?.message ?? "Remote Control could not start.", true);
      }
    });
    element("#study-remote-stop").addEventListener("click", async () => {
      await target.stop("local_stop");
      update("Remote Control stopped. The invitation and grant were revoked.");
    });
    element("#study-remote-copy").addEventListener("click", async () => {
      const invitationUrl = target.snapshot().invitationUrl;
      if (!invitationUrl) return;
      const result = await copyInvitationLink({
        invitationUrl,
        clipboard: globalThis.navigator?.clipboard,
        host,
      });
      if (result === "copied") {
        update("Invitation link copied. Treat it as a short-lived bearer secret.");
      } else {
        update("Clipboard access was unavailable. The invitation link is selected for copying.", true);
      }
    });
    update();
  }

  return Object.freeze({
    mount,
    snapshot: () => target.snapshot(),
    stop: (reason) => target.stop(reason),
  });
}
