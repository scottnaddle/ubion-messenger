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
  lastUsedAt?: number;
};

export type WizardPrefs = {
  /** item ids manually pinned — array order = display pin order */
  pins: string[];
  /** item id → open count */
  usage: Record<string, number>;
  /** item id → last opened epoch ms */
  lastUsed: Record<string, number>;
};
