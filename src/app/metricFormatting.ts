export function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "Unavailable";
  if (value < 1024) return `${value.toLocaleString()} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const power = Math.min(Math.floor(Math.log2(value) / 10), units.length);
  return `${(value / 1024 ** power).toFixed(2)} ${units[power - 1]}`;
}

export function formatDuration(ms?: number): string {
  return ms === undefined ? "—" : ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function escapeMetricText(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
