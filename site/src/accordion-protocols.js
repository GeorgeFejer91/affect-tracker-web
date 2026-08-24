export const ACCORDION_PROTOCOLS = Object.freeze({
  settings: Object.freeze({
    stateKey: "panelOpen",
    panelId: "control-panel",
    domainModule: "portable-settings.js",
    responsibilities: Object.freeze(["manual-input", "appearance", "portable-settings", "local-export"]),
  }),
  experiment: Object.freeze({
    stateKey: "experimentPanelOpen",
    panelId: "experiment-panel",
    domainModule: "experiment.js",
    responsibilities: Object.freeze(["stimulus-lifecycle", "experiment-recording", "experiment-export"]),
  }),
  touch: Object.freeze({
    stateKey: "touchPlaygroundPanelOpen",
    panelId: "touch-playground-panel",
    domainModule: "touch-trace.js",
    responsibilities: Object.freeze(["pointer-acquisition", "movement-analysis", "touch-feedback"]),
  }),
  polar: Object.freeze({
    stateKey: "polarStreamPanelOpen",
    panelId: "polar-stream-panel",
    domainModule: "polar-stream.js",
    responsibilities: Object.freeze(["bluetooth-session", "physiology-metrics", "sensor-mapping"]),
  }),
});

export const ACCORDION_PROTOCOL_IDS = Object.freeze(Object.keys(ACCORDION_PROTOCOLS));

function requireProtocol(protocolId) {
  const protocol = ACCORDION_PROTOCOLS[protocolId];
  if (!protocol) throw new TypeError(`Unknown accordion protocol: ${protocolId}`);
  return protocol;
}

export function exclusiveAccordionState(source, openProtocolId) {
  if (openProtocolId !== undefined) requireProtocol(openProtocolId);
  return Object.fromEntries(ACCORDION_PROTOCOL_IDS.map((protocolId) => [
    ACCORDION_PROTOCOLS[protocolId].stateKey,
    protocolId === openProtocolId && Boolean(source?.[ACCORDION_PROTOCOLS[protocolId].stateKey]),
  ]));
}

export function normalizeAccordionState(source) {
  const openProtocolId = ACCORDION_PROTOCOL_IDS.find(
    (protocolId) => Boolean(source?.[ACCORDION_PROTOCOLS[protocolId].stateKey]),
  );
  return exclusiveAccordionState(source, openProtocolId);
}

export function setAccordionProtocolOpen(source, protocolId, open) {
  const protocol = requireProtocol(protocolId);
  return exclusiveAccordionState(
    { ...source, [protocol.stateKey]: Boolean(open) },
    open ? protocolId : undefined,
  );
}

export function toggleAccordionProtocol(source, protocolId) {
  const protocol = requireProtocol(protocolId);
  return setAccordionProtocolOpen(source, protocolId, !Boolean(source?.[protocol.stateKey]));
}

export function touchProtocolActive({ inputSource, touchPlaygroundPanelOpen, experimentPhase = "idle" }) {
  return inputSource === "touch-trace"
    && (Boolean(touchPlaygroundPanelOpen) || experimentPhase !== "idle");
}
