import { describe, expect, it } from "vitest";
import { XmppClient, presenceStanza } from "../electron/core/xmpp";
import { BoshClient } from "../electron/core/bosh";

describe("away presence stanzas", () => {
  it("builds the exact online/away stanzas", () => {
    expect(presenceStanza("online:on")).toBe("<presence><status>online:on</status></presence>");
    expect(presenceStanza("away:on")).toBe(
      "<presence><show>away</show><status>away:on</status></presence>",
    );
  });

  it("XmppClient.setStatus writes show=away while online", () => {
    const x = new XmppClient({ host: "h", port: 1, domain: "d", username: "u", password: "p", resource: "r" });
    const sent: string[] = [];
    (x as any).phase = "online";
    (x as any).write = (s: string) => sent.push(s);
    x.setStatus("away:on");
    x.setStatus("online:on");
    expect(sent).toEqual([
      "<presence><show>away</show><status>away:on</status></presence>",
      "<presence><status>online:on</status></presence>",
    ]);
  });

  it("BoshClient.setStatus writes show=away while online", () => {
    const c = new BoshClient({ url: "u", domain: "d", username: "u", password: "p", resource: "r" });
    const sent: string[] = [];
    (c as any).phase = "online";
    (c as any).write = (s: string) => sent.push(s);
    c.setStatus("away:on");
    expect(sent).toEqual(["<presence><show>away</show><status>away:on</status></presence>"]);
  });
});
