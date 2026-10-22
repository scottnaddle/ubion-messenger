export type WizardItem = {
  id: string;
  title: string;
  subtitle?: string;
  /** portal path or absolute URL */
  url: string;
  target: "portal" | "external" | "local";
  local?: "home" | "chats" | "people" | "mail" | "approval" | "todos";
  appName?: string;
  section?: string;
  source: "menu" | "form" | "asset" | "works" | "static";
  aliases: string[];
};

export type WizardHit = WizardItem & {
  score: number;
  reason: string;
  pinned: boolean;
  usage: number;
};

export type WizardPrefs = {
  /** item ids manually pinned */
  pins: string[];
  /** item id → open count */
  usage: Record<string, number>;
};
