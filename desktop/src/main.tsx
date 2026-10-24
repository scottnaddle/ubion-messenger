import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { installMockIfNeeded } from "./mock";

const render = () => createRoot(document.getElementById("root")!).render(<App />);

if (__UBM_MOBILE__) {
  document.documentElement.classList.add("ubm-mobile");
  const useMock = new URLSearchParams(location.search).get("mock") === "1";
  void import("./mobile/entry").then(({ setupMobile }) => {
    setupMobile(useMock);
    render();
  });
} else {
  installMockIfNeeded();
  render();
}
