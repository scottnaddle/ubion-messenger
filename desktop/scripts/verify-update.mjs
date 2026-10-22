// 공개 릴리스에 대해 "현재 버전 X 가 새 버전을 감지하는지" 확인. 사용: node scripts/verify-update.mjs 1.0.2
const cur = process.argv[2] ?? "1.0.2";
const base = "https://github.com/scottnaddle/ubion-messenger-releases/releases/latest/download/";
const cmp = (a, b) => { const p = (v) => v.replace(/^v/, "").split(".").map(Number); const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; } return 0; };
for (const f of ["latest.yml", "latest-mac.yml"]) {
  const r = await fetch(base + f); if (!r.ok) { console.log(f, "HTTP", r.status); process.exitCode = 1; continue; }
  const v = (await r.text()).match(/^version:\s*(\S+)/m)[1];
  console.log(`${f}: latest=${v}  current=${cur}  updateAvailable=${cmp(v, cur) > 0}`);
}
