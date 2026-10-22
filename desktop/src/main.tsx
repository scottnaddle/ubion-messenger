import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { installMockIfNeeded } from "./mock";

installMockIfNeeded();
createRoot(document.getElementById("root")!).render(<App />);
