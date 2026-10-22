const ALPH = "nstopqrdefmabuvwxyzcghijkl";

/** UBIONMessenger main.prod.js Co()/jo() — XMPP SASL password from loginId. */
export function xmppKeyFromLoginId(loginId: string): string {
  let out = "";
  for (let n = 0; n < 10; n += 1) {
    const r = Math.floor(n / loginId.length);
    const i = n - r * loginId.length;
    const ch = loginId.charAt(i);
    const code = ch.charCodeAt(0) + 9 + 3 * r;
    out += ALPH.charAt(Math.floor((code * (i + 1)) % 26));
  }
  return out;
}
