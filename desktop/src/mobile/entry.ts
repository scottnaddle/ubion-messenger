/** Mobile (Capacitor) boot: polyfills + mobile CSS + window.ubion. Loaded only when __UBM_MOBILE__ is true. */
import "./polyfills";
import "./mobile.css";
import { installMobileBridge } from "./bridge";
import { installMockIfNeeded } from "../mock";

/** `?mock=1` keeps the fake-data bridge (UI work without a server). */
export function setupMobile(useMock: boolean) {
  if (useMock) installMockIfNeeded();
  else installMobileBridge();
}
