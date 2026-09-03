export function formatRemoteRoute(snapshot) {
  const route = snapshot?.route ?? "unknown";
  if (route === "unknown") return "Unknown";

  const label = String(route)
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (character) => character.toUpperCase());
  return `${label}${Number.isFinite(snapshot?.rttMs) ? ` · ${snapshot.rttMs} ms RTT` : ""}`;
}
