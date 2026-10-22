/** Windows taskbar overlay badge (16x16 red circle with count). */
export function drawBadge(n: number): string {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e5484d";
  g.beginPath();
  g.arc(16, 16, 15, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = `bold ${n > 9 ? 16 : 20}px "Segoe UI", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(n > 99 ? "99+" : String(n), 16, 17);
  return c.toDataURL();
}
