import { describe, expect, it } from "vitest";
import {
  normalizeStatusText, parseStatusMessage, presenceStanza, statusCaps, statusServerEnabled,
  statusXmppEnabled, xmlEscape,
} from "../electron/core/status-message";
import { handleOnlineStanza } from "../electron/core/xmpp";

describe("status message: presence stanzas", () => {
  it("keeps the exact away/online stanzas without a message", () => {
    expect(presenceStanza("online:on")).toBe("<presence><status>online:on</status></presence>");
    expect(presenceStanza("away:on")).toBe("<presence><show>away</show><status>away:on</status></presence>");
  });

  it("embeds a free-text status after the code", () => {
    expect(presenceStanza("online:on", "점심시간")).toBe("<presence><status>online:on|점심시간</status></presence>");
    expect(presenceStanza("away:on", "회의 중")).toBe("<presence><show>away</show><status>away:on|회의 중</status></presence>");
  });

  it("escapes XML in the status text", () => {
    expect(presenceStanza("online:on", "a < b & c")).toBe("<presence><status>online:on|a &lt; b &amp; c</status></presence>");
    expect(xmlEscape(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("status message: parsing", () => {
  it("extracts our encoded status text", () => {
    expect(parseStatusMessage("away:on|회의 중")).toBe("회의 중");
    expect(parseStatusMessage("online:on|점심")).toBe("점심");
  });

  it("returns null for known presence codes", () => {
    expect(parseStatusMessage("away:on")).toBeNull();
    expect(parseStatusMessage("online:on")).toBeNull();
    expect(parseStatusMessage("away:on|")).toBeNull();
    expect(parseStatusMessage("busy:1")).toBeNull();
    expect(parseStatusMessage(undefined)).toBeNull();
    expect(parseStatusMessage("")).toBeNull();
  });

  it("treats free text (not a known code) as a status message", () => {
    expect(parseStatusMessage("회의 중")).toBe("회의 중");
    expect(parseStatusMessage("In a meeting")).toBe("In a meeting");
  });

  it("prefers the show element (away/dnd) to keep a message that looks like a code", () => {
    expect(parseStatusMessage("away to lunch", "away")).toBe("away to lunch");
  });

  it("normalizes and caps status text", () => {
    expect(normalizeStatusText("  안녕  ")).toBe("안녕");
    expect(normalizeStatusText("가".repeat(200))).toHaveLength(100);
    expect(normalizeStatusText(undefined)).toBe("");
  });
});

describe("status message: realtime presence parsing (xmpp)", () => {
  it("emits statusText alongside status/show", () => {
    const events: Array<{ event: string; payload: any }> = [];
    handleOnlineStanza(
      `<presence from="1247@xmppdaou.com/pc"><status>회의 중</status></presence>`,
      { write: () => undefined, domain: "d", emit: (event, payload) => events.push({ event, payload }) },
    );
    expect(events[0]).toMatchObject({
      event: "presence",
      payload: { local: "1247", status: "회의 중", statusText: "회의 중" },
    });
  });

  it("keeps away:on as a presence code (no statusText)", () => {
    const events: Array<{ event: string; payload: any }> = [];
    handleOnlineStanza(
      `<presence from="8@d/pc"><show>away</show><status>away:on</status></presence>`,
      { write: () => undefined, domain: "d", emit: (event, payload) => events.push({ event, payload }) },
    );
    expect(events[0].payload).toMatchObject({ local: "8", status: "away:on", statusText: null });
  });
});

describe("status message: flags", () => {
  it("exposes caps from env", () => {
    expect(statusCaps({})).toEqual({ xmpp: false, server: false });
    expect(statusCaps({ UBM_STATUS_XMPP: "1" })).toEqual({ xmpp: true, server: false });
    expect(statusCaps({ UBM_STATUS_SERVER: "1" })).toEqual({ xmpp: false, server: true });
    expect(statusXmppEnabled({ UBM_STATUS_XMPP: "0" })).toBe(false);
    expect(statusServerEnabled({ UBM_STATUS_SERVER: "true" })).toBe(false);
  });
});
