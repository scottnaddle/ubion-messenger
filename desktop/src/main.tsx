import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PersonalBotSettingsWindow } from "./components/PersonalBotSettings";
import { parseBotSettingsSearch } from "./lib/personal-bot-settings";
import "./styles.css";
import { installMockIfNeeded } from "./mock";

installMockIfNeeded();
const botSettings = parseBotSettingsSearch(window.location.search);
createRoot(document.getElementById("root")!).render(
  botSettings ? <PersonalBotSettingsWindow userId={botSettings.userId} /> : <App />,
);
